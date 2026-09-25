// 灵犀审方集成删除（owner 裁定 2026-09-25：永不启用）的逐字节等价闸门。
//
// 生产环境 RXAI_AUDIT_ENABLED=false、RXAI_QUERY_ENABLED=false，每一次 M05 都走「显式停用」档
// （遥测 reasonCode 全是 audit_rxaudit_disabled）。删除远端客户端、载荷构造、供应商归一、
// 配伍查询与呈现开关之后，三条临床路由对外的每一个字节都必须与删除前一致：外部集成方按
// 对外接口文档消费 audit.source / auditReason / presentationDisabled / auditCorrelation 等字段，
// 签名收据（工作台 attestation、warningObservation 的 MAC）也绑定这些取值。
//
// fixture 来源：在删除前的基线提交 68ea3f0 上用 CAPTURE=1 跑本脚本，把三条路由的原始响应
// （状态码 + 响应体原文）落盘；删除后默认模式逐字比对。时间被冻结、网络被禁止、模型全部未配置，
// 因此两次运行之间唯一可能的差异来自被测代码本身。
//
// 另一份 fixture（medication-scope.json）钉的是「显式停用」档里唯一还在工作的用药史判据：
// 本次/局部未用药、现用药不详 → 待核对提示。基线上由旧 runBoundedRxAudit 的停用分支 +
// buildAuditInputAdvisories 产出，覆盖从本仓测试里收集的全部用药史类文本。
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { createJiti } from "jiti";
import { buildAuditPositiveControlState } from "./lib/primary-care-audit-positive-controls.mjs";

const FIXTURE_DIR = new URL("./fixtures/rxaudit-removal-equivalence/", import.meta.url);
const CAPTURE = process.env.CAPTURE === "1";

// 生产取值。RXAI_* 在删除后已无读者；保留设置是为了让基线捕获走生产分支。
for (const key of Object.keys(process.env)) if (key.startsWith("RXAI_") || key === "CDSS_SHOW_RX_AUDIT_SECTION") delete process.env[key];
Object.assign(process.env, {
  RXAI_AUDIT_ENABLED: "false", RXAI_QUERY_ENABLED: "false",
  CDSS_CLINICAL_FACTS_BACKSTOP: "true", M05_FOLLOWUP_AUTHORING: "false",
  REASONING_CONTRACT_SIGNING_KEY: "rxaudit-removal-equivalence-signing-key-at-least-32-chars",
});
for (const key of ["OPENAI_API_KEY", "BAILIAN_QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "EVIMED_API_KEY",
  "EVIMED_EVIDENCE_API_KEY", "EVIMED_GUIDE_API_KEY", "GLM_API_KEY", "CDSS_GATE_DISPOSITION", "CDSS_REDFLAG_DOSE_AUTHORIZATION"]) delete process.env[key];

// 冻结时间：auditedAt / generatedAt / 相关性标记里的时间戳与收据 MAC 都随之确定。
const FIXED_NOW = Date.parse("2026-09-25T08:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length > 0 ? args : [FIXED_NOW])); }
  static now() { return FIXED_NOW; }
}
globalThis.Date = FixedDate;

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const signatures = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const { POST: assess } = await jiti.import("../src/app/api/diagnosis/assess/route.ts");
const { POST: postRisk } = await jiti.import("../src/app/api/diagnosis/post-prescription-risk/route.ts");
const { POST: hisScheme } = await jiti.import("../src/app/api/diagnosis/his-scheme/route.ts");
const { issuePrescriptionRevisionAttestation } = await jiti.import("../src/lib/prescription-revision-attestation.server.ts");
const { invalidatePrescriptionContractAfterEdit } = await jiti.import("../src/lib/prescription-revision.ts");
const { computePrescriptionVersionHash } = await jiti.import("../src/lib/prescription-version.ts");
const { revisionFromAudit, applyAcceptedPrescriptionDisplayResult, applyCompletedM05DisplayResult, buildAcceptedPrescriptionMarkdown } = await jiti.import("../src/lib/followup-display-state.ts");
const { consumeMarkdownStreamWithMetadata } = await jiti.import("../src/lib/diagnosis-engine.ts");
const { derivePrescriptionPermission, withSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { maybeAttachClinicalFactsBackstop } = await jiti.import("../src/lib/clinical-facts-runtime.ts");
const { getTcmHerbFunctionText } = await jiti.import("../src/lib/tcm-knowledge.ts");
const { getM03TherapyLock } = await jiti.import("../src/lib/m03-therapy-lock.ts");
const { findLocalPatentMedicineEntry } = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
const { medicineCandidateTable } = await jiti.import("../src/lib/medicine-rendering.ts");
const { getCdssStageTelemetrySnapshot } = await jiti.import("../src/lib/cdss-stage-telemetry.ts");
const customer = { clientId: "local-development", customerId: "test-hospital" };

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls += 1; throw new Error("offline equivalence harness prohibits external calls"); };

function caseFor({
  id = "rx-equivalence", medicationHistory = "否认当前用药", herbs = [{ name: "黄芪", dose: "15g" }, { name: "茯苓", dose: "12g" }],
  sex = "男", age = 46, pastHistory = "否认重要慢病", chiefComplaint = "入睡困难三个月", mutate,
} = {}) {
  const control = { id, patient: { sex, age }, chiefComplaint, diagnosis: "失眠障碍", syndrome: "心脾两虚证", pastHistory, allergyHistory: "否认药物过敏", medicationHistory, herbs };
  const raw = { ...buildAuditPositiveControlState(control), customerId: "test-hospital", phase: "done", vitals: { T: "36.5", P: "75", R: "18", BP: "120/80", SpO2: "99%" } };
  mutate?.(raw.reasoningPrescribe);
  const state = normalizeCaseStateInput(raw);
  const m03 = { ...structuredClone(state.reasoningPrescribe), stage: "diagnose", formula: null, nonPharma: null, clinicalReview: undefined,
    overview: { ...state.reasoningPrescribe.overview, recommendedFormulaNames: [], formulaSelectionMode: "self_devised" } };
  state.reasoningDiagnose = signatures.signDiagnoseReasoning(m03, signatures.buildDiagnoseContractSignatureContext(state));
  const m04 = structuredClone(state.reasoningPrescribe);
  state.reasoningPrescribe = signatures.signPrescribeReasoning(m04, signatures.buildPrescribeContractSignatureContext(state));
  state.reasoningV2 = state.reasoningPrescribe;
  return state;
}
const readyCaseFor = async (options) => maybeAttachClinicalFactsBackstop(caseFor(options), async () => JSON.stringify({ redFlags: [] }));
function request(path, caseState) {
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", "x-cdss-customer-id": "test-hospital" }, body: JSON.stringify({ caseState }) });
}

async function signedMultiCandidate(options, candidateIndex, unsafeIndex) {
  const state = await readyCaseFor(options);
  const reasoning = structuredClone(state.reasoningPrescribe);
  reasoning.formula.candidates = Array.from({ length: 3 }, (_, index) => ({
    ...structuredClone(reasoning.formula.candidates[0]),
    name: `本例候选${index + 1}`,
    therapyMatch: getM03TherapyLock(state.reasoningDiagnose).candidateMatch,
    herbs: reasoning.formula.candidates[0].herbs.map((herb, herbIndex) => ({
      ...herb,
      ...(index === unsafeIndex ? { name: herbIndex === 0 ? "甘草" : "海藻" } : {}),
      dose: `${herbIndex === 0 ? 15 + index : 12}g`,
      function: getTcmHerbFunctionText(index === unsafeIndex ? (herbIndex === 0 ? "甘草" : "海藻") : herb.name),
    })),
  }));
  state.prescription = buildAcceptedPrescriptionMarkdown(reasoning, candidateIndex);
  state.reasoningPrescribe = signatures.signPrescribeReasoning(reasoning, signatures.buildPrescribeContractSignatureContext(state));
  state.reasoningV2 = state.reasoningPrescribe;
  return state;
}

async function withPatentMedicine(options) {
  const state = await signedMultiCandidate(options, 0);
  const reasoning = structuredClone(state.reasoningPrescribe);
  const entry = findLocalPatentMedicineEntry("外感风寒颗粒");
  reasoning.formula.patentAndWestern = [{ type: "中成药", name: entry.name, specification: entry.specification,
    evidenceId: "LOCAL-INST-007", evidenceFingerprint: entry.fingerprint, recommendationMode: "candidate_review",
    positioning: "需医生评估", correspondingProblem: "恶寒无汗", usageBoundary: "仅作身份与联用关系复核",
    relationship: "与中药饮片不默认联用", riskNote: "请按说明书复核",
    evidence: { evidenceLevel: "kb_entry", source: "本地药品说明书 [LOCAL-INST-007]", confidence: "中" } }];
  state.prescription += `\n\n${medicineCandidateTable(reasoning.formula.patentAndWestern, state).join("\n")}`;
  state.reasoningPrescribe = signatures.signPrescribeReasoning(reasoning, signatures.buildPrescribeContractSignatureContext(state));
  state.reasoningV2 = state.reasoningPrescribe;
  return state;
}

async function workbenchCase(options, candidateIndex = 0) {
  const state = await readyCaseFor(options);
  const revised = invalidatePrescriptionContractAfterEdit(structuredClone(state.reasoningPrescribe));
  Object.assign(revised.formula.candidates[0], { name: "益气安神方（医生编辑版）", constructionType: "self_devised", modificationStatus: "modified" });
  if (candidateIndex > 0) {
    const safe = structuredClone(revised.formula.candidates[0]);
    safe.therapyMatch = getM03TherapyLock(state.reasoningDiagnose).candidateMatch;
    safe.herbs = safe.herbs.map((herb) => ({ ...herb, function: getTcmHerbFunctionText(herb.name) }));
    revised.formula.candidates = Array.from({ length: candidateIndex + 1 }, () => structuredClone(safe));
  }
  state.reasoningPrescribe = revised; state.reasoningV2 = revised;
  const herbHash = await computePrescriptionVersionHash(revised, candidateIndex, state);
  state.prescriptionRevision = { source: "herb_workbench", candidateIndex, herbHash, auditedAt: new Date().toISOString(), auditResult: "MANUAL_REVIEW", highestRiskLevel: "HIGH", auditAvailable: false };
  return state;
}

async function diagnoseOnly(options) {
  const state = await readyCaseFor(options);
  return { ...state, prescription: "", reasoningPrescribe: undefined, reasoningV2: state.reasoningDiagnose, prescriptionRevision: undefined };
}

const HERB_VARIANTS = {
  clean: {},
  eighteen_incompatible: { herbs: [{ name: "甘草", dose: "6g" }, { name: "海藻", dose: "9g" }] },
  eighteen_incompatible_gansui: { herbs: [{ name: "甘草", dose: "6g" }, { name: "甘遂", dose: "1g" }] },
  nineteen_caution: { herbs: [{ name: "丁香", dose: "3g" }, { name: "郁金", dose: "9g" }] },
  over_pharmacopoeia_limit: { herbs: [{ name: "细辛", dose: "10g" }, { name: "茯苓", dose: "12g" }] },
  dose_sanity_ceiling: { herbs: [{ name: "黄芪", dose: "999999g" }] },
  pregnancy: { sex: "女", age: 28, pastHistory: "妊娠12周", chiefComplaint: "妊娠12周，入睡困难三个月",
    herbs: [{ name: "桃仁", dose: "9g" }, { name: "红花", dose: "6g" }, { name: "茯苓", dose: "12g" }] },
  missing_dose: { herbs: [{ name: "黄芪", dose: "" }, { name: "茯苓", dose: "12g" }] },
  unparseable_dose: { herbs: [{ name: "黄芪", dose: "适量" }, { name: "茯苓", dose: "12g" }] },
  regimen_incomplete: { mutate: (reasoning) => { reasoning.formula.candidates[0].decoction.course = "视病情而定"; } },
  medication_unknown: { medicationHistory: "现用药不详" },
  medication_local_absence: { medicationHistory: "发病后未服药" },
  medication_current: { medicationHistory: "现服阿司匹林100mg，每日1次" },
  medication_long_term_local_absence: { medicationHistory: "长期服用阿司匹林，发病后未服药" },
  medication_empty: { medicationHistory: "" },
};

async function capture(label, handler, path, state) {
  const response = await handler(request(`/api/diagnosis/${path}`, state));
  const text = await response.text();
  return { label, path, status: response.status, body: text };
}

const results = [];
async function allRoutes(label, state) {
  for (const [path, handler] of [["assess", assess], ["post-prescription-risk", postRisk], ["his-scheme", hisScheme]]) {
    results.push(await capture(label, handler, path, state));
  }
}

for (const [name, options] of Object.entries(HERB_VARIANTS)) {
  await allRoutes(`signed-m04/${name}`, await readyCaseFor({ id: `rx-eq-${name}`, ...options }));
}
for (const name of ["clean", "eighteen_incompatible", "medication_unknown", "missing_dose"]) {
  await allRoutes(`diagnose-only/${name}`, await diagnoseOnly({ id: `rx-eq-dx-${name}`, ...HERB_VARIANTS[name] }));
}
{
  // 缺结构化药味：只有未签名的处方 Markdown（审方层历史上会解析它）。
  const state = await readyCaseFor({ id: "rx-eq-legacy-markdown" });
  const legacy = { ...state, prescription: buildAcceptedPrescriptionMarkdown(state.reasoningPrescribe, 0),
    reasoningPrescribe: undefined, reasoningV2: state.reasoningDiagnose, prescriptionRevision: undefined };
  await allRoutes("missing-structured/legacy-markdown", legacy);
  const empty = structuredClone(state);
  empty.reasoningPrescribe.formula.candidates[0].herbs = [];
  empty.reasoningV2 = empty.reasoningPrescribe;
  await allRoutes("missing-structured/empty-candidate-unsigned", empty);
}
for (const [candidateIndex, unsafeIndex] of [[1, undefined], [2, 2], [1, 2]]) {
  const state = await signedMultiCandidate({ id: `rx-eq-multi-${candidateIndex}-${unsafeIndex}` }, candidateIndex, unsafeIndex);
  await allRoutes(`multi-candidate/${candidateIndex}/unsafe-${unsafeIndex}`, state);
  // 客户端伪造的「已审」元数据：服务端必须以不可伪造的跳过收据替换它。
  const forged = structuredClone(state);
  forged.prescriptionRevision = { source: "herb_workbench", candidateIndex, herbHash: "fnv1a-client-forgery",
    auditedAt: new Date(0).toISOString(), auditResult: "PASS", highestRiskLevel: "INFO", auditAvailable: true };
  await allRoutes(`multi-candidate/${candidateIndex}/unsafe-${unsafeIndex}/forged-pass`, forged);
  const herbHash = await computePrescriptionVersionHash(state.reasoningPrescribe, candidateIndex, state);
  const prior = { source: "herb_workbench", candidateIndex, herbHash, auditedAt: new Date().toISOString(),
    auditResult: "BLOCK", highestRiskLevel: "CRITICAL", auditAvailable: true, degraded: false, needManualReview: true };
  const retained = structuredClone(state);
  retained.prescriptionRevision = { ...prior, ...issuePrescriptionRevisionAttestation(state, customer, prior) };
  await allRoutes(`multi-candidate/${candidateIndex}/unsafe-${unsafeIndex}/attested-critical`, retained);
}
for (const name of ["clean", "medication_unknown", "medication_current"]) {
  await allRoutes(`patent-medicine/${name}`, await withPatentMedicine({ id: `rx-eq-patent-${name}`, ...HERB_VARIANTS[name] }));
}

// 工作台完整链路：改方 → post-prescription-risk 签发跳过收据 → M05 → HIS。
const WORKBENCH_VARIANTS = [["clean", 0], ["eighteen_incompatible", 0], ["nineteen_caution", 0], ["over_pharmacopoeia_limit", 0],
  ["pregnancy", 0], ["medication_local_absence", 0], ["medication_unknown", 0], ["missing_dose", 0], ["unparseable_dose", 0],
  ["regimen_incomplete", 0], ["clean", 1], ["attested_critical", 0], ["attested_critical_then_changed", 0], ["empty_candidate", 0]];
for (const [name, candidateIndex] of WORKBENCH_VARIANTS) {
  const baseVariant = name.startsWith("attested_critical") || name === "empty_candidate" ? "clean" : name;
  const submitted = await workbenchCase({ id: `rx-eq-wb-${name}-${candidateIndex}`, ...HERB_VARIANTS[baseVariant] }, candidateIndex);
  if (name.startsWith("attested_critical")) {
    const prior = { ...submitted.prescriptionRevision, auditResult: "BLOCK", highestRiskLevel: "CRITICAL", auditAvailable: true, degraded: false, needManualReview: true };
    submitted.prescriptionRevision = { ...prior, ...issuePrescriptionRevisionAttestation(submitted, customer, prior) };
    if (name === "attested_critical_then_changed") {
      submitted.reasoningPrescribe.formula.candidates[0].herbs[0].dose = "12g";
      submitted.reasoningV2 = submitted.reasoningPrescribe;
    }
  }
  if (name === "empty_candidate") {
    submitted.reasoningPrescribe.formula.candidates[0].herbs = [];
    submitted.reasoningV2 = submitted.reasoningPrescribe;
  }
  const label = `workbench/${name}/${candidateIndex}`;
  const postResult = await capture(label, postRisk, "post-prescription-risk", submitted);
  results.push(postResult);
  if (postResult.status !== 200) continue;
  const body = JSON.parse(postResult.body);
  const accepted = { caseId: submitted.id, reasoning: submitted.reasoningPrescribe, auditSection: body.section, followupSection: body.followup.trim(),
    followupTimeline: body.followupTimeline, serverSafetyLocked: derivePrescriptionPermission(withSafetyGate(submitted)).formalAdoption === "blocked",
    revision: revisionFromAudit(body.audit, candidateIndex, body.audit.herbHash, true) };
  const final = applyAcceptedPrescriptionDisplayResult(submitted, accepted);
  const normalized = normalizeCaseStateInput(JSON.parse(JSON.stringify(final)));
  const assessed = await assess(request("/api/diagnosis/assess", normalized));
  const assessText = await assessed.clone().text();
  results.push({ label, path: "assess", status: assessed.status, body: assessText });
  if (assessed.status !== 200) continue;
  const streamed = await consumeMarkdownStreamWithMetadata(assessed, () => {}, { collectWarningProfile: true });
  const completed = applyCompletedM05DisplayResult(normalized, streamed, customer.customerId);
  results.push({ label, path: "completed-m05-state", status: 0, body: JSON.stringify(completed) });
  results.push(await capture(label, hisScheme, "his-scheme", completed));
  // 同一版本再次提交（已持有跳过收据）：收据必须原样可复用。
  results.push(await capture(`${label}/resubmit`, postRisk, "post-prescription-risk", normalized));
  // 伪造收据 MAC：三条路由必须维持既有拒绝码。
  const forged = structuredClone(normalized);
  forged.prescriptionRevision.attestation = `hmac-sha256:${"0".repeat(64)}`;
  await allRoutes(`${label}/forged-mac`, forged);
}

const telemetry = getCdssStageTelemetrySnapshot();
results.push({ label: "telemetry", path: "stage-telemetry", status: 0, body: JSON.stringify(telemetry) });
assert.equal(fetchCalls, 0, "production-equivalent runs must never reach the network");

mkdirSync(FIXTURE_DIR, { recursive: true });
const fixtureUrl = new URL("routes.json.gz", FIXTURE_DIR);
if (CAPTURE) {
  writeFileSync(fixtureUrl, gzipSync(`${JSON.stringify(results, null, 1)}\n`, { level: 9 }));
  console.log(`captured ${results.length} route outputs`);
} else {
  const expected = JSON.parse(gunzipSync(readFileSync(fixtureUrl)).toString("utf8"));
  assert.equal(results.length, expected.length, "route output count");
  let mismatches = 0;
  for (const [index, actual] of results.entries()) {
    const want = expected[index];
    assert.equal(`${actual.label} ${actual.path}`, `${want.label} ${want.path}`, `fixture order at ${index}`);
    if (actual.status !== want.status || actual.body !== want.body) {
      mismatches += 1;
      let at = 0;
      while (at < Math.min(actual.body.length, want.body.length) && actual.body[at] === want.body[at]) at += 1;
      console.error(`MISMATCH ${actual.label} ${actual.path}: status ${want.status}→${actual.status}; first diff at ${at}\n  want: ${JSON.stringify(want.body.slice(Math.max(0, at - 80), at + 160))}\n  got:  ${JSON.stringify(actual.body.slice(Math.max(0, at - 80), at + 160))}`);
    }
  }
  assert.equal(mismatches, 0, `${mismatches} route outputs differ from the pre-removal baseline`);
  console.log(`rxaudit removal equivalence: ${results.length} route outputs byte-identical to baseline 68ea3f0`);
}
