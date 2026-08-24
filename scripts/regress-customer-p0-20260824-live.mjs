/**
 * 甲方 2026-08-24 P0 复验：三个病例形状各重复 20 次，证明线上镜像的确定性出口
 * 不再出现虚构阴性查体、已知阳性被说成“未确认”、稀疏/红旗病例仍给具体证候或方剂方向。
 *
 * 用法：
 *   BASE_URL=https://host/tcm-cdss CDSS_API_TOKEN=xxx CDSS_CUSTOMER_ID=xxx \
 *     npm run regress:customer-p0-20260824
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import physicalExamClaimLexicon from "../src/data/physical-exam-claim-lexicon.source.json" with { type: "json" };

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const CUSTOMER_ID = process.env.CDSS_CUSTOMER_ID || "";
const SAMPLES = Math.max(1, Math.min(20, Number.parseInt(process.env.CUSTOMER_P0_SAMPLES || "20", 10) || 20));
const CONCURRENCY = Math.max(1, Math.min(3, Number.parseInt(process.env.CUSTOMER_P0_CONCURRENCY || "3", 10) || 3));
const FIXTURE_FILTER = (process.env.CUSTOMER_P0_FIXTURE || "").trim();
const OUT = process.env.OUT || "artifacts/customer-p0-20260824-live.json";
if (!TOKEN) throw new Error("CDSS_API_TOKEN required");
if (!CUSTOMER_ID) throw new Error("CDSS_CUSTOMER_ID required");

const COMPLETE = { level: "C", redFlag: 0.8, infoGain: 0.8, managementImpact: 0.8, answerability: 0.8 };
const SPARSE = { level: "B", redFlag: 0.8, infoGain: 0.4, managementImpact: 0.4, answerability: 0.4 };
const base = (label, index) => ({
  id: `customer-p0-${label}-${index + 1}-${randomUUID()}`,
  customerId: CUSTOMER_ID,
  phase: "diagnose",
  patient: { sex: "女", age: 35 },
  conversation: [],
  questionRounds: 0,
  maxQuestionRounds: 1,
  diagnosis: "",
  prescription: "",
  riskAssessment: "",
});

const fixtures = [
  {
    id: "complete_wind_cold_cough",
    make: (index) => ({
      ...base("cough", index),
      patient: { sex: "男", age: 35 },
      chiefComplaint: "咳嗽伴恶寒无汗3天",
      symptoms: {
        presentHistory: "3天前淋雨后出现咳嗽，咳白稀痰，鼻塞流清涕，头身酸痛，恶寒明显，无汗。否认高热、咯血、胸痛和呼吸困难。",
        respiratory: "咳嗽、白稀痰、鼻塞流清涕",
        general: "恶寒、无汗、头身酸痛",
      },
      tongue: "舌淡红，苔薄白",
      pulse: "脉浮紧",
      faceNote: "神清，面色正常",
      vitals: { T: "37.0℃", P: "78次/分", R: "18次/分", BP: "118/76mmHg", SpO2: "98%" },
      pastHistory: "既往体健，否认哮喘和慢性肺病。",
      medicationHistory: "本次尚未使用其他药物。",
      allergyHistory: "否认药物过敏。",
      completeness: COMPLETE,
    }),
  },
  {
    id: "sparse_headache_one_day",
    make: (index) => ({
      ...base("headache", index),
      chiefComplaint: "轻微头痛1天",
      symptoms: { presentHistory: "今日出现轻微头痛，具体诱因和伴随表现尚未补充。" },
      tongue: "",
      pulse: "",
      vitals: {},
      pastHistory: "",
      medicationHistory: "本次尚未使用其他药物。",
      allergyHistory: "",
      completeness: SPARSE,
    }),
  },
  {
    id: "acute_chest_pain_red_flag",
    make: (index) => ({
      ...base("chest-pain", index),
      patient: { sex: "男", age: 58 },
      chiefComplaint: "突发胸痛1小时",
      symptoms: { presentHistory: "突发胸骨后压榨样疼痛1小时，向左肩背放射，伴大汗、气促和濒死感，休息不缓解。" },
      tongue: "",
      pulse: "",
      vitals: {},
      pastHistory: "高血压病史8年。",
      medicationHistory: "当前用药信息待核。",
      allergyHistory: "",
      completeness: COMPLETE,
    }),
  },
];
const selectedFixtures = FIXTURE_FILTER
  ? fixtures.filter((fixture) => fixture.id === FIXTURE_FILTER)
  : fixtures;
if (selectedFixtures.length === 0) throw new Error(`unknown CUSTOMER_P0_FIXTURE: ${FIXTURE_FILTER}`);

function consume(raw) {
  let content = "";
  let error = "";
  let sawEnd = false;
  for (const line of raw.split("\n").filter(Boolean)) {
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (typeof frame.error === "string") error = frame.error;
    if (frame.content === "[END]") { sawEnd = true; continue; }
    if (typeof frame.content !== "string") continue;
    content = frame.content.startsWith("<<<CDSS_STREAM_FINAL>>>")
      ? frame.content.slice("<<<CDSS_STREAM_FINAL>>>".length)
      : content + frame.content;
  }
  return { content, error, sawEnd };
}

function reasoningOf(content) {
  const match = content.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

async function diagnose(caseState) {
  const startedAt = Date.now();
  const response = await fetch(`${BASE_URL}/api/diagnosis/diagnose`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cdss-api-token": TOKEN,
      "x-cdss-customer-id": CUSTOMER_ID,
    },
    body: JSON.stringify({ caseState }),
    signal: AbortSignal.timeout(220_000),
  });
  const stream = consume(await response.text());
  return { status: response.status, durationMs: Date.now() - startedAt, ...stream, reasoning: reasoningOf(stream.content) };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EXAM_CLAIM_ANCHOR = new RegExp(`(?:${physicalExamClaimLexicon.groups
  .flatMap((group) => group.terms)
  .map(escapeRegExp)
  .join("|")})`);
const EXAM_NEGATIVE_CUE = new RegExp(`(?:${physicalExamClaimLexicon.claimCues.map(escapeRegExp).join("|")})`);
const EXAM_LIMITATION_CUE = /(?:(?:本次病历)?未记录|无(?:相关)?记录|未查|未做|待补充|需(?:现场)?补充|需核实|待核实|无(?:本次病历)?依据)/g;
const REFERENCE_LINE = /^\s*(?:(?:[-*>]|\d+[.)])\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?(?:参考文献|文献依据|文献来源|指南(?:原文|条文|依据|来源|标准)?|证据(?:引用|来源|依据)?|引用|出处|诊断标准|鉴别标准)(?:\*\*|__)?\s*[：:]/;
const PHYSICAL_EXAM_ASSERTION_FIELDS = new Set([
  "supportingFacts", "primarySyndromeBasis", "patientFact", "syndromeEvidence",
  "clinicalRationale", "tcmDiagnosticRationale", "limitations", "suggestedChecks",
  "reason", "distinguishingPoints", "nextCheck", "overallPathogenesis", "summary",
  "mechanism", "basis", "affects", "followupSafetyNet",
]);
const DIAGNOSIS_SENTINEL_BLOCK = /<!-- DIAGNOSIS_JSON_START -->\s*[\s\S]*?\s*<!-- DIAGNOSIS_JSON_END -->/g;

function ungroundedNegativeExamExcerpt(content, protectReferenceLines = false) {
  for (const line of content.split("\n")) {
    if (protectReferenceLines && (REFERENCE_LINE.test(line) || /https?:\/\/|\[[^\]]+\]\([^\s)]+\)/.test(line))) continue;
    for (const clause of line.split(/[。；;，,]|(?=但|而|仍|却|同时|另有|随后|继而|并且|且)/)) {
      const assertionProbe = clause.replace(EXAM_LIMITATION_CUE, "");
      if (EXAM_CLAIM_ANCHOR.test(assertionProbe) && EXAM_NEGATIVE_CUE.test(assertionProbe)) {
        return assertionProbe.trim();
      }
    }
  }
  return "";
}

function structuredUngroundedExamExcerpt(value, key = "", path = "reasoning") {
  if (typeof value === "string") {
    if (!PHYSICAL_EXAM_ASSERTION_FIELDS.has(key)) return "";
    const excerpt = ungroundedNegativeExamExcerpt(value);
    return excerpt ? `${path}: ${excerpt}` : "";
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const excerpt = structuredUngroundedExamExcerpt(value[index], key, `${path}[${index}]`);
      if (excerpt) return excerpt;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  for (const [childKey, childValue] of Object.entries(value)) {
    const excerpt = structuredUngroundedExamExcerpt(childValue, childKey, `${path}.${childKey}`);
    if (excerpt) return excerpt;
  }
  return "";
}

function responseUngroundedExamExcerpt(content, reasoning) {
  const visibleExcerpt = ungroundedNegativeExamExcerpt(content.replace(DIAGNOSIS_SENTINEL_BLOCK, ""), true);
  return visibleExcerpt || structuredUngroundedExamExcerpt(reasoning);
}
if (!ungroundedNegativeExamExcerpt("患者肺部听诊未闻及啰音。")) {
  throw new Error("回归守卫未能识别未接地阴性查体反例");
}
if (!ungroundedNegativeExamExcerpt("证据不足，患者腹部触诊无压痛。")) {
  throw new Error("回归守卫未能覆盖受治理词表中的其他查体类别");
}
if (!ungroundedNegativeExamExcerpt("腹软，无压痛及反跳痛。")) {
  throw new Error("回归守卫未能识别腹部查体阴性组合");
}
if (!ungroundedNegativeExamExcerpt("肺部听诊未记录但双肺呼吸音正常。")) {
  throw new Error("回归守卫不得让限制说明豁免同句转折后的阴性查体断言");
}
if (ungroundedNegativeExamExcerpt("本次病历未记录肺部听诊结果，需现场补充，SpO2正常。")) {
  throw new Error("回归守卫不得把补采限制误判为阴性查体");
}
if (ungroundedNegativeExamExcerpt("- **参考文献**：指南鉴别标准：肺部听诊未闻及啰音。", true)) {
  throw new Error("回归守卫不得把受治理参考文献当作患者查体断言");
}
const referenceOnlyReasoning = { guidelineReferences: [{ citation: "指南鉴别标准：肺部听诊未闻及啰音" }] };
const referenceOnlySentinel = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(referenceOnlyReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
if (responseUngroundedExamExcerpt(referenceOnlySentinel, referenceOnlyReasoning)) {
  throw new Error("回归守卫不得扫描 sentinel 中的结构化引用元数据");
}
if (!structuredUngroundedExamExcerpt({ westernDiagnosis: { primary: { clinicalRationale: "肺部听诊未闻及啰音" } } })) {
  throw new Error("回归守卫未能识别 sentinel 患者断言字段中的阴性查体");
}
const CONTRADICTORY_HEADACHE_UNKNOWN = /(?:尚未确认|未记录|未明确)[^。；\n]{0,12}头痛(?:是否存在)?|头痛(?:是否存在)?[^。；\n]{0,12}(?:尚未确认|未记录|未明确)/;

function hasFormulaSpecificity(reasoning) {
  const overview = reasoning?.overview || {};
  return Boolean(
    String(overview.recommendedFormulaDirection || "").trim()
    || (overview.recommendedFormulaNames || []).length
    || overview.deferredFormulaSelection,
  );
}

function hasTcmDecisionSpecificity(reasoning) {
  const overview = reasoning?.overview || {};
  const pathogenesis = reasoning?.pathogenesis || {};
  const therapy = reasoning?.therapy || {};
  return Boolean(
    String(overview.tcmDiseaseName || "").trim()
    || String(overview.tcmDiseaseRationale || "").trim()
    || String(overview.tcmDiagnosticRationale || "").trim()
    || (overview.tcmDifferentials || []).length
    || (overview.tcmDiseaseDifferentials || []).length
    || (overview.secondarySyndromes || []).length
    || (pathogenesis.locationDifferentiation?.items || []).length
    || (pathogenesis.natureDifferentiation?.items || []).length
    || (pathogenesis.symptomClusters || []).length
    || pathogenesis.caseRelationship
    || (pathogenesis.chain || []).length
    || (therapy.subTherapies || []).length
    || reasoning?.formula
    || reasoning?.nonPharma
    || reasoning?.lineageAdaptation
    || (reasoning?.terminologyMappings || []).length
  );
}

const jobs = selectedFixtures.flatMap((fixture) => Array.from({ length: SAMPLES }, (_, index) => ({ fixture, index })));
const results = new Array(jobs.length);
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < jobs.length) {
    const jobIndex = cursor;
    cursor += 1;
    const { fixture, index } = jobs[jobIndex];
    const response = await diagnose(fixture.make(index));
    const failures = [];
    if (response.status !== 200 || !response.sawEnd || !response.reasoning) {
      failures.push(`HTTP/stream/contract status=${response.status} end=${response.sawEnd} error=${response.error}`);
    }
    const ungroundedExamExcerpt = responseUngroundedExamExcerpt(response.content, response.reasoning);
    if (ungroundedExamExcerpt) {
      failures.push(`出现无病历依据的阴性查体断言: ${ungroundedExamExcerpt}`);
    }
    if (fixture.id === "sparse_headache_one_day") {
      if (CONTRADICTORY_HEADACHE_UNKNOWN.test(response.content)) failures.push("把已记录头痛说成未确认或未记录");
      if (response.reasoning?.overview?.primarySyndromeResolution !== "unresolved") failures.push("稀疏病例证候未收敛为 unresolved");
      if (response.reasoning?.overview?.primarySyndrome !== "症状级工作判断") failures.push("稀疏病例仍输出具体证候");
      if (hasFormulaSpecificity(response.reasoning)) failures.push("稀疏病例仍输出方剂方向");
      if (hasTcmDecisionSpecificity(response.reasoning)) failures.push("稀疏病例仍泄露具体证候/病机/治法");
    }
    if (fixture.id === "acute_chest_pain_red_flag") {
      if (response.reasoning?.overview?.primarySyndromeResolution !== "unresolved") failures.push("红旗病例证候未收敛为 unresolved");
      if (response.reasoning?.overview?.primarySyndrome !== "症状级工作判断") failures.push("红旗病例仍输出具体证候");
      if (hasFormulaSpecificity(response.reasoning)) failures.push("红旗病例仍输出方剂方向");
      if (hasTcmDecisionSpecificity(response.reasoning)) failures.push("红旗病例仍泄露具体证候/病机/治法");
    }
    results[jobIndex] = { fixture: fixture.id, sample: index + 1, status: response.status, durationMs: response.durationMs, failures };
    const outcome = failures.length ? `FAIL ${failures.join(" | ")}` : "PASS";
    console.log(`[customer-p0] ${fixture.id} ${index + 1}/${SAMPLES} ${outcome} ${response.durationMs}ms`);
  }
}));

const failures = results.flatMap((result) => result.failures.map((failure) => ({ ...result, failure })));
const summary = {
  suite: "customer-p0-20260824-live",
  baseUrl: BASE_URL,
  samplesPerFixture: SAMPLES,
  totalRequests: results.length,
  failures: failures.length,
  byFixture: Object.fromEntries(selectedFixtures.map(({ id }) => {
    const rows = results.filter((row) => row.fixture === id);
    return [id, {
      samples: rows.length,
      failures: rows.reduce((sum, row) => sum + row.failures.length, 0),
      maxDurationMs: Math.max(...rows.map((row) => row.durationMs)),
    }];
  })),
  failureDetails: failures,
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(failures.length > 0 ? 1 : 0);
