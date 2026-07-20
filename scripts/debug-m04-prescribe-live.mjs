// Live debug harness for the M04 deterministic herb-contract gauntlet (unregistered, not a test).
// EXACT replica of the production M04 pipeline for evaluator caseStates with real signed M03
// priors (artifacts/real-100-smoke-r6-20260719/*.txt):
//   toCaseState + reasoningDiagnose → withSafetyGate → maybeAttachClinicalFactsBackstop (REAL) →
//   derivePrescriptionPermission → sanitizeCaseStateForModel → buildCdssEvidenceContext +
//   buildPrescribePrompt (shortlist section printed) → real prescribe model → proposal compile →
//   deterministic transform chain → strict + advisory contract checks with per-herb issue codes →
//   real independent M04 reviewer per round.
// Run: node --env-file-if-exists=.env.local scripts/debug-m04-prescribe-live.mjs [ES03,ES04] [runs]
// Prints only sanitized clinical payloads and verdicts; never prints env or credentials.
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const { withSafetyGate, sanitizeCaseStateForModel, clinicalGroundingText, sanitizeUngroundedRedFlagNegations, derivePrescriptionPermission, authoritativePatientAgeYears } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { maybeAttachClinicalFactsBackstop } = await jiti.import("../src/lib/clinical-facts-runtime.ts");
const { buildCdssEvidenceContext, appendEvidenceContext, buildEvidenceOutputTransform } = await jiti.import("../src/lib/cdss-evidence-context.ts");
const { buildPrescribePrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
const { diagnoseReasoningFromState, parseReasoningV2 } = await jiti.import("../src/lib/diagnosis-parse.ts");
const { m04SemanticIssue, highImpactHerbDirectionIssue, canonicalTcmHerbIdentity } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { buildM04ClinicalReviewPrompt, parseM04ClinicalReview } = await jiti.import("../src/lib/m04-clinical-review.ts");
const { compileM04JsonObjectContent } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { resolveCompletedStructuredResponse, enforceStructuredStageOwnership } = await jiti.import("../src/lib/diagnosis-structured-repair.ts");
const { applyDeterministicFormulaReferences, enrichReasoning, formulaCompilationContractIssue } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const { isKnownTcmHerbName, getTcmHerbFunctionText, getTcmHerbFunctionCategories, getTcmHerbDoseLimit } = await jiti.import("../src/lib/tcm-knowledge.ts");
const { applyDeterministicDecoctionMethod, applyDeterministicFollowUpNode, applyDeterministicHerbTargets, applyDeterministicCandidateTherapyMatch, applyDeterministicHerbDecoctionRequirements, applyDeterministicHerbFunctions, applyDeterministicHerbPrescriptionRoles, applyDeterministicFormulaAnalysis } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const { enforceReviewedPrescriptionOutput } = await jiti.import("../src/lib/prescription-output-safety.ts");
const { applyTcmTreatmentCapabilityPriority } = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
const { buildM04ClinicalRepairHint } = await jiti.import("../src/lib/structured-clinical-repair.ts");
const { getPrimaryTextModelConfig } = await jiti.import("../src/lib/text-model.ts");

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const CDSS_SYSTEM_PROMPT = [
  "你是中医 CDSS AI Agent，请用中文输出结构化、可读的临床辅助决策内容。",
  "内容仅供医生辅助参考，必须包含必要的安全提醒，避免替代执业医师最终诊疗决策。",
  "审方相关内容只做风险提示和医生复核点，不做硬拦截、自动通过或最终裁决。",
  "如果用户提示要求输出 DIAGNOSIS_JSON_START/END 结构化数据，必须在回复末尾完整输出，且不得放入 Markdown 代码块；DIAGNOSIS_JSON_END 必须是最后一个非空内容。",
  "不得伪造指南、文献题名、年份、链接或 DOI；没有明确来源时省略客户正文中的来源字段，并仅在结构化 evidence 中标记内部证据缺口。",
].join("\n");

const config = getPrimaryTextModelConfig();
if (!config.configured) {
  console.error("primary text model not configured (check .env.local)");
  process.exit(2);
}
const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
const prescribeModel = process.env.PRIMARY_PRESCRIBE_MODEL?.trim() || config.model;
const repairModel = process.env.PRIMARY_PRESCRIBE_REPAIR_MODEL?.trim() || process.env.PRIMARY_DIAGNOSE_MODEL?.trim() || config.model;
const reviewModel = process.env.PRIMARY_CLINICAL_REVIEW_MODEL?.trim() || process.env.PRIMARY_REVIEW_MODEL?.trim() || config.model;
const prescribeMaxTokens = Number(process.env.PRIMARY_PRESCRIBE_MAX_TOKENS) > 0
  ? Number(process.env.PRIMARY_PRESCRIBE_MAX_TOKENS)
  : Number(process.env.PRIMARY_TEXT_MAX_TOKENS) > 0 ? Number(process.env.PRIMARY_TEXT_MAX_TOKENS) : 14_000;
const prescribeEffort = (process.env.PRIMARY_PRESCRIBE_REASONING_EFFORT || "low").trim();
const reviewEffort = (process.env.PRIMARY_CLINICAL_REVIEW_REASONING_EFFORT || "low").trim();

async function chat({ model, system, user, maxTokens, effort, timeoutMs = 170_000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        stream: false,
        max_tokens: maxTokens,
        temperature: 0,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        reasoning_effort: effort,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return body?.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timeout);
  }
}

// Exact replica of scripts/regress-real-100-evaluate.mjs toCaseState.
const COMPLETE = { level: "C", redFlag: 0.85, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 };
function toCaseState(c) {
  const hist = (c.hist || "").trim();
  const state = {
    id: c.id,
    phase: "collect",
    patient: { sex: c.sex || "男", age: Number.isFinite(c.age) ? c.age : 45 },
    chiefComplaint: c.chief || "未提供主诉",
    symptoms: hist ? { presentHistory: hist } : {},
    pastHistory: "无特殊可记录。",
    allergyHistory: "否认药物食物过敏。",
    medicationHistory: "否认当前用药。",
    tongue: "舌淡红,苔薄白",
    pulse: "细平",
    faceNote: "面色如常",
    completeness: COMPLETE,
    conversation: [],
    diagnosis: "",
    prescription: "",
    riskAssessment: "",
  };
  if (hist) {
    state.hisRecord = {
      schemaVersion: "tcm-cdss-his-v1",
      source: "tcm-cdss-his",
      caseId: c.id,
      updatedAt: new Date().toISOString(),
      tongueImageUploaded: false,
      fields: { xianbingshi: hist },
      rawText: `【现病史】${hist}`,
    };
  }
  if (c.vitals && Object.keys(c.vitals).length) {
    state.vitals = {};
    if (c.vitals.bp) state.vitals.bp = c.vitals.bp;
    if (c.vitals.hr) state.vitals.heartRate = String(c.vitals.hr);
    if (c.vitals.t) state.vitals.temperature = String(c.vitals.t);
    if (c.vitals.rr) state.vitals.respiratoryRate = String(c.vitals.rr);
    if (c.vitals.spo2) state.vitals.spo2 = String(c.vitals.spo2);
  }
  return state;
}

const FIXTURES = {
  ES03: { id: "ES03", sex: "男", age: 58, chief: "高血压控制稳定,仍头晕,要求中药治疗", hist: "高血压8年,规律服氨氯地平,血压控制在130/80mmHg左右;近2月晨起头晕头胀、项背强,本次明确要求加用中药。舌红苔薄黄,脉弦。", vitals: { bp: "132/82" } },
  ES04: { id: "ES04", sex: "男", age: 56, chief: "糖尿病血糖稳定,仍口干乏力,要求中药干预", hist: "2型糖尿病6年,二甲双胍治疗,空腹血糖6-7mmol/L;近半年口干多饮、疲乏,本次明确要求中药治疗。舌红少津少苔,脉细数。", vitals: {} },
  NG05: { id: "NG05", sex: "男", age: 45, chief: "上呼吸道感染,体温37.2℃无寒战", hist: "感冒2天,流涕咽痛,体温最高37.2℃,无寒战、无意识改变。", vitals: { t: "37.2", hr: "80" } },
  NG06: { id: "NG06", sex: "女", age: 42, chief: "慢性胃炎,轻度上腹隐痛", hist: "慢性胃炎5年,轻度上腹隐痛,无板状腹、无拒按。", vitals: { bp: "120/80" } },
  TC01: { id: "TC01", sex: "男", age: 45, chief: "胃脘胀满饭后加重3月", hist: "饭后胃胀,嗳气,大便偏稀。舌淡胖有齿痕苔白腻。", vitals: {} },
  TC02: { id: "TC02", sex: "男", age: 45, chief: "腹泻腹痛2天", hist: "进食生冷后腹泻日4次,稀水样,轻度腹痛。舌淡苔白腻。", vitals: {} },
  TC04: { id: "TC04", sex: "男", age: 45, chief: "反酸烧心1月", hist: "夜间反酸烧心,平卧加重。舌红苔薄黄。", vitals: {} },
  SP09: { id: "SP09", sex: "男", age: 45, chief: "冠心病稳定型心绞痛", hist: "劳力性胸痛2年,规律服药,本次就诊开药。", vitals: { bp: "130/80", hr: "72" } },
  ES09: { id: "ES09", sex: "男", age: 45, chief: "咳嗽5天", hist: "现病史一处记录“咳嗽5天”,另一处旧病程写“慢性咳嗽3年已愈半年”;本次确有5天新起咳嗽咳痰,时态记载互相矛盾。舌淡红苔薄白。", vitals: {} },
};

const PRIOR_ARTIFACT_DIRS = ["artifacts/real-100-residual-r1-20260719", "artifacts/real-100-smoke-r6-20260719"];

function loadSignedPrior(caseId) {
  for (const dir of PRIOR_ARTIFACT_DIRS) {
    let raw;
    try {
      raw = readFileSync(`${dir}/${caseId}-full.txt`, "utf8");
    } catch {
      continue;
    }
    const blocks = [...raw.matchAll(/<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/g)];
    for (const block of blocks.reverse()) {
      try {
        const parsed = JSON.parse(block[1]);
        if (parsed?.stage === "diagnose") return parseReasoningV2(parsed);
      } catch { /* try next */ }
    }
  }
  return undefined;
}

function extractSentinelJson(content) {
  const start = content.lastIndexOf(START);
  const end = start >= 0 ? content.indexOf(END, start + START.length) : -1;
  if (start < 0 || end < 0) return "";
  return content.slice(start + START.length, end).trim();
}

function herbRows(reasoning) {
  return (reasoning?.formula?.candidates?.[0]?.herbs || []).map((herb, index) => ({
    index,
    name: herb.name,
    dose: herb.dose,
    role: herb.role,
    targetRef: herb.targetRef,
    known: isKnownTcmHerbName(String(herb.name || "")),
    kbText: `${getTcmHerbFunctionText(String(herb.name || ""))} | ${getTcmHerbFunctionCategories(String(herb.name || "")).join("/")}`,
    highImpactIssue: highImpactHerbDirectionIssue(String(herb.name || ""), String(herb.function || herb.prescriptionRole || ""), PRIOR),
  }));
}

let PRIOR;

async function prepareCase(fixture) {
  const prior = loadSignedPrior(fixture.id);
  if (!prior) throw new Error(`no signed M03 artifact for ${fixture.id}`);
  PRIOR = prior;
  const base = { ...toCaseState(fixture), reasoningDiagnose: prior };
  const deterministicGate = withSafetyGate(base);
  const caseState = deterministicGate.safetyGate?.status === "red_flag"
    ? base
    : await maybeAttachClinicalFactsBackstop(base, undefined, undefined);
  const gated = withSafetyGate(caseState);
  const permission = derivePrescriptionPermission(gated);
  const trustedGated = { ...gated, reasoningDiagnose: prior };
  const safeState = sanitizeCaseStateForModel(trustedGated);
  let evidenceContext = "";
  try {
    evidenceContext = await buildCdssEvidenceContext(safeState, "prescribe");
  } catch {
    evidenceContext = "";
  }
  const prompt = appendEvidenceContext(buildPrescribePrompt(safeState), evidenceContext);
  const grounding = clinicalGroundingText(safeState);
  const age = authoritativePatientAgeYears(gated);
  return { prior, gated, permission, safeState, evidenceContext, prompt, grounding, age };
}

async function runM04Pipeline(fixture, prepared, runIndex) {
  const { prior, safeState, evidenceContext, prompt, grounding, age } = prepared;
  console.log(`\n-- ${fixture.id} run ${runIndex} --`);
  const shortlistMatch = prompt.match(/【本例治法方向的知识库覆盖药味短名单[^]*?(?=\n\n|$)/);
  console.log("kbShortlist:", shortlistMatch ? JSON.stringify(shortlistMatch[0].slice(0, 500)) : "ABSENT");
  let rejectedJson = "";
  let lastReason = "";
  for (let round = 1; round <= 3; round += 1) {
    const isRepair = round > 1;
    // Replica of the server's deterministic dose-boundary hint (doseOutsideConservativeRange).
    let doseBoundaryHint = "";
    const doseMatch = isRepair ? lastReason.match(/^m04_candidate_\d+_herb_(\d+)_dose_outside_conservative_range$/) : null;
    if (doseMatch && rejectedJson) {
      try {
        const rejectedReasoning = JSON.parse(rejectedJson);
        const herbName = rejectedReasoning?.formula?.candidates?.[0]?.herbs?.[Number(doseMatch[1])]?.name;
        const limit = typeof herbName === "string" && herbName.trim() ? getTcmHerbDoseLimit(herbName.trim()) : null;
        if (herbName && limit?.min != null && limit.max != null) {
          doseBoundaryHint = `⚠️ 剂量边界：${String(herbName).trim()} 的服务端保守常用量区间为 ${limit.min}–${limit.max}g。只把该味剂量调整到该区间内（优先中低段），其余已通过校验的药味、剂量与组成保持不变。`;
        }
      } catch { /* keep generic hint */ }
    }
    let unsupportedHighImpactHint = "";
    const highImpactMatch = isRepair ? lastReason.match(/^m04_candidate_\d+_herb_(\d+)_unsupported_high_impact_([a-z0-9_]+)$/) : null;
    if (highImpactMatch && rejectedJson) {
      try {
        const rejectedReasoning = JSON.parse(rejectedJson);
        const herbName = rejectedReasoning?.formula?.candidates?.[0]?.herbs?.[Number(highImpactMatch[1])]?.name;
        const conceptLabels = { heat_clear: "清热", yang_warm: "温阳", blood_move: "活血", purge: "泻下", orifice_open: "开窍", mass_soften: "软坚" };
        const conceptLabel = conceptLabels[highImpactMatch[2]] || highImpactMatch[2];
        if (typeof herbName === "string" && herbName.trim()) {
          unsupportedHighImpactHint = `⚠️ 高影响方向：${herbName.trim()} 带有本例签名 M03 治法与患者事实均未成立的「${conceptLabel}」方向。直接删除该药或换用已成立治法方向上的药味，不得仅改剂量、改角色或改写理由保留。`;
        }
      } catch { /* keep generic hint */ }
    }
    let emperorDirectionHint = "";
    const emperorMismatchMatch = isRepair ? lastReason.match(/^m04_candidate_\d+_herb_(\d+)_emperor_therapy_mismatch$/) : null;
    if (emperorMismatchMatch && rejectedJson) {
      try {
        const rejectedReasoning = JSON.parse(rejectedJson);
        const herbName = rejectedReasoning?.formula?.candidates?.[0]?.herbs?.[Number(emperorMismatchMatch[1])]?.name;
        const chain = prior.pathogenesis?.chain || [];
        const primaryNode = chain.find((node, index) => String(node.nodeId || `P${index + 1}`) === "P1") || chain[0];
        const direction = [primaryNode?.therapyDirection, prior.therapy?.overallPrinciple]
          .filter((value) => typeof value === "string" && value.trim())
          .join("；");
        if (typeof herbName === "string" && herbName.trim() && direction) {
          emperorDirectionHint = `⚠️ 君药方向：${herbName.trim()} 的知识库收载方向不覆盖本例 P1 治法「${direction.slice(0, 80)}」。请只从短名单对应方向中重选能直接承担该治法的君药，其余已通过校验的药味、剂量与组成保持不变。`;
        }
      } catch { /* keep generic hint */ }
    }
    let unknownHerbHint = "";
    const unknownHerbMatch = isRepair ? lastReason.match(/^m04_candidate_\d+_herb_(\d+)_unknown$/) : null;
    if (unknownHerbMatch && rejectedJson) {
      try {
        const rejectedReasoning = JSON.parse(rejectedJson);
        const herbName = rejectedReasoning?.formula?.candidates?.[0]?.herbs?.[Number(unknownHerbMatch[1])]?.name;
        if (typeof herbName === "string" && herbName.trim()) {
          const canonical = canonicalTcmHerbIdentity(herbName.trim());
          if (canonical && canonical !== herbName.trim() && isKnownTcmHerbName(canonical)) {
            unknownHerbHint = `⚠️ 药名规范：「${herbName.trim()}」不在服务端药味知识库中，其规范名称为「${canonical}」。请直接改用「${canonical}」，其余已通过校验的药味、剂量与组成保持不变。`;
          } else {
            unknownHerbHint = `⚠️ 药名规范：「${herbName.trim()}」不在服务端药味知识库中（可能为生造、错别字或不规范缩写）。不得再次使用该名称，请从短名单或知识库已收载药味中选择同一治法方向的替代药味，其余字段保持不变。`;
          }
        }
      } catch { /* keep generic hint */ }
    }
    const userPrompt = !isRepair
      ? prompt
      : [
          "请定向修复以下 prescribe 结构化 JSON。只输出一个合法 JSON 对象，不要输出 sentinel、正文、代码围栏或额外说明。",
          `未通过原因代码：${lastReason}。`,
          doseBoundaryHint,
          unsupportedHighImpactHint,
          emperorDirectionHint,
          unknownHerbHint,
          buildM04ClinicalRepairHint(lastReason),
          "M04 修复结果始终必须是 schemaVersion=tcm-cdss-m04-proposal-v1 的最小提案对象；candidate.herbs 必须是数组且只含本次实际采用药味；candidate.decoction 必须是单个对象，且必须包含格式严格为1–30整数加‘剂’的 doseCount 纯字符串；整个 candidate.herbs 必须恰有 1–2 味君药，且每味君药都必须 targetKind=pathogenesis_node、targetRef=P1；targetKind=pathogenesis_node 时 structureRole 必须为 null。顶层还必须包含 patentAndWestern 数组、modifications 数组以及完整 nonPharma 对象；无逐药可靠证据时 patentAndWestern 输出空数组。modifications 仅允许0-4条无剂量条件性加减，包含 trigger/targetRef/actionType/herbName/reason。nonPharma 的 diet、lifestyle、emotion 必须是非空字符串，acupointCare 固定为 null，monitoring 至少一项且包含 metric、timing、trigger。",
          `M03锁定上下文：${JSON.stringify({ overview: { primarySyndrome: prior.overview?.primarySyndrome, overallPathogenesis: prior.overview?.overallPathogenesis, recommendedFormulaDirection: prior.overview?.recommendedFormulaDirection, recommendedFormulaNames: prior.overview?.recommendedFormulaNames, formulaSelectionMode: prior.overview?.formulaSelectionMode }, therapy: prior.therapy, pathogenesisChain: prior.pathogenesis?.chain })}`,
          `患者事实边界：${grounding.slice(0, 12_000)}`,
          `待修复JSON：${rejectedJson}`,
        ].filter(Boolean).join("\n\n");
    const started = Date.now();
    const rawOutput = await chat({
      model: isRepair ? repairModel : prescribeModel,
      system: CDSS_SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: Math.max(prescribeMaxTokens, Math.min(Math.round(prescribeMaxTokens * 1.5), 32_000)),
      effort: isRepair ? "medium" : prescribeEffort,
    });
    const genMs = Date.now() - started;
    const compiledObject = compileM04JsonObjectContent(rawOutput, prior);
    if (!compiledObject) {
      console.log(`round ${round} (${genMs}ms): proposal compilation rejected`);
      lastReason = "m04_proposal_invalid";
      rejectedJson = rawOutput.slice(0, 6_000);
      continue;
    }
    const compiled = `${START}\n${JSON.stringify(compiledObject)}\n${END}`;
    if (round === 1 && runIndex === 1) {
      console.log("debug compiledHead:", JSON.stringify(compiled.slice(0, 300)));
      console.log("debug compiledStage:", JSON.stringify(compiledObject?.stage), "schemaVersion:", JSON.stringify(compiledObject?.schemaVersion));
    }
    // Server deterministic chain.
    const resolved = resolveCompletedStructuredResponse(compiled, "prescribe", "stop") || compiled;
    let content = applyDeterministicFormulaReferences(enforceStructuredStageOwnership(resolved, "prescribe"));
    content = applyDeterministicFormulaAnalysis(applyDeterministicHerbPrescriptionRoles(applyDeterministicHerbFunctions(applyDeterministicHerbDecoctionRequirements(applyDeterministicCandidateTherapyMatch(applyDeterministicHerbTargets(content, prior), prior)))));
    content = applyDeterministicFollowUpNode(applyDeterministicDecoctionMethod(content, grounding, age));
    let transformed = content;
    let transformError = "";
    try {
      const routeTransform = buildEvidenceOutputTransform(
        evidenceContext,
        (value) => sanitizeUngroundedRedFlagNegations(enforceReviewedPrescriptionOutput(value), safeState),
      );
      transformed = applyTcmTreatmentCapabilityPriority(routeTransform(content), safeState, prior);
    } catch (error) {
      transformError = error instanceof Error ? error.message : "transform_error";
    }
    const reasoning = parseReasoningV2(transformed.includes(START) ? transformed : content);
    const enriched = reasoning ? enrichReasoning(reasoning).reasoning : undefined;
    const strictCompilationIssue = enriched ? formulaCompilationContractIssue(enriched, prior, false, false) : "parse_failed";
    const strictSemanticIssue = enriched ? m04SemanticIssue(enriched, "", prior, isKnownTcmHerbName, true, true, false, false) : "parse_failed";
    const advisorySemanticIssue = enriched ? m04SemanticIssue(enriched, "", prior, isKnownTcmHerbName, true, true, false, true) : "parse_failed";
    console.log(`round ${round} (${isRepair ? "repair" : "initial"}, ${genMs}ms):`);
    console.log("herbs:", JSON.stringify(herbRows(enriched), null, 1));
    console.log("issues:", JSON.stringify({ compilation: strictCompilationIssue || "none", semanticStrict: strictSemanticIssue || "none", semanticAdvisory: advisorySemanticIssue || "none", transformError: transformError || "none" }));
    const blockingIssue = strictCompilationIssue || strictSemanticIssue;
    if (enriched && !blockingIssue) {
      const reviewStarted = Date.now();
      const reviewOutput = await chat({
        model: reviewModel,
        system: "你是独立中药候选处方临床复核器，只输出约定 JSON。不得编造患者事实。",
        user: buildM04ClinicalReviewPrompt(grounding, prior, enriched, evidenceContext),
        maxTokens: 800,
        effort: reviewEffort,
      });
      const reviewMs = Date.now() - reviewStarted;
      const verdict = parseM04ClinicalReview(reviewOutput);
      console.log(`reviewer (${reviewMs}ms):`, JSON.stringify({ status: verdict.status, issueCode: verdict.issueCode }));
      if (verdict.status === "accepted") {
        console.log(`RESULT: dose-level accepted in round ${round}`);
        return "accepted";
      }
      lastReason = verdict.status === "repair" ? `m04_${verdict.issueCode}_semantic_review` : "m04_clinical_semantic_review";
      console.log("reviewRaw:", JSON.stringify(reviewOutput.slice(0, 400)));
      rejectedJson = extractSentinelJson(content).slice(0, 8_000);
      continue;
    }
    lastReason = blockingIssue ? `m04_${blockingIssue}` : transformError;
    rejectedJson = extractSentinelJson(content).slice(0, 8_000);
  }
  console.log("RESULT: exhausted → non-dose contract (production path)");
  return "non_dose";
}

const only = process.argv[2] ? process.argv[2].split(",") : ["ES03", "ES04"];
const runs = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 3;
for (const id of only) {
  const fixture = FIXTURES[id];
  if (!fixture) continue;
  console.log(`\n=== ${id} ===`);
  const prepared = await prepareCase(fixture);
  console.log("prior:", JSON.stringify({
    syndrome: prepared.prior.overview?.primarySyndrome,
    therapy: prepared.prior.therapy?.overallPrinciple,
    permission: prepared.permission.candidateMode,
    evidenceChars: prepared.evidenceContext.length,
  }));
  const outcomes = [];
  for (let run = 1; run <= runs; run += 1) {
    outcomes.push(await runM04Pipeline(fixture, prepared, run));
  }
  console.log(`${id} harness outcomes:`, JSON.stringify(outcomes));
}
