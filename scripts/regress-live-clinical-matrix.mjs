import { createJiti } from "jiti";
import {
  evaluateLimitedNoDose,
  parseHttpResponse,
  responseComplete,
} from "./lib/primary-care-sparse-50-contracts.mjs";

const BASE_URL = (
  process.env.BASE_URL ||
  process.env.TCM_CDSS_BASE_URL ||
  "http://127.0.0.1:3000"
).replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || process.env.TCM_CDSS_API_TOKEN || "";
const STREAMING_ROUTES = new Set([
  "/api/diagnosis/collect",
  "/api/diagnosis/question",
  "/api/diagnosis/diagnose",
  "/api/diagnosis/prescribe",
  "/api/diagnosis/assess",
]);
const TIMEOUT_MS = Number(process.env.CLINICAL_MATRIX_TIMEOUT_MS || 300_000);
const CASE_FILTER = new Set((process.env.CLINICAL_MATRIX_CASES || "").split(",").map((item) => item.trim()).filter(Boolean));
const selected = (caseId) => CASE_FILTER.size === 0 || CASE_FILTER.has(caseId);
const jiti = createJiti(import.meta.url);
const { findTcmHerbPairIncompatibilities, getTcmHerbDoseLimit } = jiti("../src/lib/tcm-knowledge.ts");
const { isMechanicallyPreventableAuditIssue } = jiti("../src/lib/rxaudit.ts");

const results = [];
const record = (caseId, stage, ok, detail = "") => {
  results.push({ caseId, stage, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${caseId} ${stage}${detail ? ` | ${detail}` : ""}`);
};

async function request(path, caseState, requestBody) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
      body: JSON.stringify(requestBody || { caseState }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `clinical matrix authentication failed (${response.status}) for ${path}; ` +
        "set CDSS_API_TOKEN or TCM_CDSS_API_TOKEN for the target environment",
      );
    }
    const parsed = parseHttpResponse({
      status: response.status,
      raw,
      contentType: response.headers.get("content-type") || "",
      elapsedMs: Date.now() - startedAt,
    });
    if (response.ok && STREAMING_ROUTES.has(path) && !responseComplete(parsed, "stream")) {
      throw new Error(`incomplete response contract for ${path}: ${parsed.parseError || `endCount=${parsed.endCount},tail=${parsed.nonHeartbeatAfterEnd}`}`);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function reasoningFrom(content, stage) {
  const startMarker = "<!-- DIAGNOSIS_JSON_START -->";
  const endMarker = "<!-- DIAGNOSIS_JSON_END -->";
  const start = content.lastIndexOf(startMarker);
  const end = start >= 0 ? content.indexOf(endMarker, start + startMarker.length) : -1;
  if (start < 0 || end < 0) return null;
  try {
    const parsed = JSON.parse(content.slice(start + startMarker.length, end).trim());
    return parsed?.stage === stage ? parsed : null;
  } catch {
    return null;
  }
}

function baseCase(id, fields) {
  return {
    id: `matrix_${id}_${Date.now()}`,
    phase: "collect",
    patient: { sex: fields.sex, age: fields.age },
    chiefComplaint: fields.chiefComplaint,
    symptoms: { presentHistory: fields.presentHistory, tcmDetail: fields.tcmDetail || "" },
    tongue: fields.tongue,
    pulse: fields.pulse,
    faceNote: fields.faceNote || "神志清楚",
    vitals: fields.vitals || { T: "36.6℃", P: "76次/分", R: "18次/分", BP: "120/78mmHg" },
    pastHistory: fields.pastHistory || "否认严重心脑血管疾病及其他重要慢病",
    medicationHistory: fields.medicationHistory || "否认当前用药及保健品",
    allergyHistory: fields.allergyHistory || "否认药物及食物过敏",
    completeness: { level: "C", redFlag: 0.9, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 },
    questionRounds: 1,
    maxQuestionRounds: 1,
    conversation: [],
  };
}

const fullCases = [
  {
    id: "digestive",
    westernPrimary: /功能性消化不良|慢性胃炎/,
    domain: /功能性消化不良|慢性胃炎|痞满|胃脘|脾胃|胃失和降/,
    forbidden: /慢性失眠|心脾两虚证|归脾汤/,
    expectedFacts: [/饭后|进食后/, /早饱|纳差/, /大便偏溏|便质偏溏|便溏/],
    minProjects: 1,
    state: baseCase("digestive", { sex: "男", age: 42, chiefComplaint: "饭后上腹胀满、嗳气3个月", presentHistory: "进食后加重，伴早饱纳差、大便偏溏；无消瘦、吞咽困难、呕血、黑便、发热。未查幽门螺杆菌。", tongue: "舌淡胖有齿痕，苔白腻", pulse: "脉缓弱" }),
  },
  {
    id: "respiratory",
    westernPrimary: /感染后咳嗽|咳嗽/,
    domain: /感染后咳嗽|咳嗽|肺失宣降|宣肺|疏风|润燥/,
    forbidden: /细菌感染确诊|抗菌药必需|归脾汤/,
    expectedFacts: [/干咳|咽痒/, /SpO2\s*98/],
    minProjects: 1,
    state: baseCase("respiratory", { sex: "女", age: 36, chiefComplaint: "感冒后干咳、咽痒4周", presentHistory: "少痰，无发热、气促、喘憋、咯血，SpO2 98%，未使用ACEI。", tongue: "舌偏红，苔薄白", pulse: "脉浮缓", pastHistory: "无慢性肺病；月经规律，否认妊娠、哺乳及备孕" }),
  },
  {
    id: "pain",
    westernPrimary: /膝.{0,4}(?:骨性)?关节炎|膝关节退行性/,
    domain: /膝骨关节炎|膝痹|痹证|通络止痛|祛湿|肝肾不足/,
    forbidden: /慢性失眠|归脾汤/,
    expectedFacts: [/膝|上下楼/, /晨僵/, /无外伤|否认外伤/],
    minProjects: 1,
    state: baseCase("pain", { sex: "男", age: 58, chiefComplaint: "右膝上下楼疼痛半年", presentHistory: "负重及上下楼加重，晨僵少于30分钟；无外伤、红肿热、锁膝、肢体麻木无力。", tongue: "舌暗，苔薄白", pulse: "脉弦涩", medicationHistory: "塞来昔布200mg疼痛时服，每周2至3次" }),
  },
  {
    id: "gynecology",
    westernPrimary: /原发性痛经|痛经/,
    domain: /原发性痛经|痛经|寒凝血瘀|气滞血瘀|温经|活血止痛/,
    forbidden: /妊娠待确认|归脾汤/,
    expectedFacts: [/经血色暗|血块/, /热敷缓解/],
    minProjects: 1,
    state: baseCase("gynecology", { sex: "女", age: 29, chiefComplaint: "经行首日小腹痛8个月", presentHistory: "经血色暗有血块，热敷缓解；无大量出血、晕厥、发热、异常分泌物。末次月经时间规律，否认妊娠、哺乳及备孕。", tongue: "舌暗有瘀点，苔薄白", pulse: "脉弦涩", medicationHistory: "布洛芬200mg必要时服" }),
  },
  {
    id: "dermatology",
    westernPrimary: /特应性皮炎|湿疹|接触性皮炎/,
    domain: /特应性皮炎|接触性皮炎|湿疮|湿热蕴肤|血虚风燥|祛湿止痒/,
    forbidden: /系统抗菌药必需|归脾汤/,
    expectedFacts: [/屈侧|肘窝|腘窝/, /瘙痒|红疹/],
    minProjects: 0,
    state: baseCase("dermatology", { sex: "女", age: 31, chiefComplaint: "肘窝、腘窝反复瘙痒红疹6个月", presentHistory: "屈侧分布，皮肤干燥伴少量渗液；无脓液、发热、面部肿胀或呼吸困难。否认妊娠、哺乳及备孕。", tongue: "舌红，苔微腻", pulse: "脉滑", medicationHistory: "间断外用1%氢化可的松", allergyHistory: "进食海鲜后曾出现荨麻疹；否认已知药物过敏" }),
  },
  {
    id: "metabolic",
    westernPrimary: /2型糖尿病|糖尿病周围神经/,
    westernCoverage: /周围神经|双足麻木/,
    domain: /2型糖尿病|糖尿病周围神经|消渴|气阴两虚|络脉瘀阻/,
    forbidden: /停用二甲双胍|停用缬沙坦|停用阿司匹林|归脾汤/,
    expectedFacts: [/HbA1c\s*8\.4/, /eGFR\s*52/, /双足麻木/],
    minProjects: 1,
    state: baseCase("metabolic", { sex: "男", age: 62, chiefComplaint: "口渴乏力、双足麻木3个月", presentHistory: "2型糖尿病10年，高血压；HbA1c 8.4%，eGFR 52mL/min/1.73m2，无低血糖及足溃疡。", tongue: "舌暗红少津，苔少", pulse: "脉细涩", pastHistory: "2型糖尿病、高血压病史", medicationHistory: "二甲双胍0.5g每日2次、缬沙坦80mg每日1次、阿司匹林100mg每日1次" }),
  },
  {
    id: "ent_rhinitis",
    westernPrimary: /过敏性鼻炎|变应性鼻炎/,
    domain: /过敏性鼻炎|鼻鼽|肺气|卫表|宣肺|通窍/,
    forbidden: /细菌性鼻窦炎确诊|抗菌药必需|归脾汤/,
    expectedFacts: [/晨起|清水样鼻涕/, /眼痒|鼻痒/],
    minProjects: 1,
    state: baseCase("ent_rhinitis", { sex: "女", age: 27, chiefComplaint: "晨起喷嚏、清水样鼻涕反复2个月", presentHistory: "鼻痒、眼痒，换季和接触灰尘后加重；无发热、面痛、脓涕或气促。否认妊娠、哺乳及备孕。", tongue: "舌淡，苔薄白", pulse: "脉浮缓", allergyHistory: "尘螨过敏；否认药物过敏" }),
  },
  {
    id: "headache",
    westernPrimary: /偏头痛/,
    domain: /偏头痛|头痛|肝阳|风痰|瘀阻|平肝|通络止痛/,
    forbidden: /确诊(?:为|：)?蛛网膜下腔出血|脑出血确诊|归脾汤/,
    expectedFacts: [/单侧|右侧|搏动/, /畏光|恶心/],
    minProjects: 1,
    state: baseCase("headache", { sex: "女", age: 34, chiefComplaint: "反复右侧搏动性头痛1年", presentHistory: "每月2至3次，每次4至12小时，伴恶心和畏光，休息后缓解；无突发最剧烈头痛、发热、肢体无力、言语含糊。否认妊娠、哺乳及备孕。", tongue: "舌红，苔薄", pulse: "脉弦" }),
  },
  {
    id: "neuro_rehab",
    westernPrimary: /脑梗死|缺血性脑卒中|卒中后/,
    domain: /脑梗死后|卒中后|中风后遗|偏瘫|气虚血瘀|通络|康复/,
    forbidden: /新发脑卒中|溶栓适应证|归脾汤/,
    expectedFacts: [/3个月|三个月/, /右侧肢体无力/, /病情稳定|无新发/],
    minProjects: 1,
    state: baseCase("neuro_rehab", { sex: "男", age: 66, chiefComplaint: "脑梗死后右侧肢体无力3个月，要求康复调理", presentHistory: "出院后病情稳定，可扶杖行走，右手精细动作较差；近三个月无新发口角歪斜、言语不清或意识改变。", tongue: "舌暗有瘀点，苔薄白", pulse: "脉细涩", pastHistory: "高血压、脑梗死恢复期", medicationHistory: "阿司匹林100mg每日1次、阿托伐他汀20mg每晚、氨氯地平5mg每日1次" }),
  },
  {
    id: "urology",
    westernPrimary: /良性前列腺增生|下尿路症状/,
    domain: /良性前列腺增生|下尿路症状|癃闭|膀胱气化|肾气|利尿|通淋/,
    forbidden: /确诊(?:为|：)?急性尿潴留|前列腺癌确诊|归脾汤/,
    expectedFacts: [/夜尿3次|夜尿/, /尿线细|排尿等待/],
    minProjects: 0,
    state: baseCase("urology", { sex: "男", age: 64, chiefComplaint: "夜尿增多、尿线变细半年", presentHistory: "夜尿每晚3次，排尿等待、尿不尽感；无发热、腰痛、尿痛、肉眼血尿或完全排不出尿。PSA尚未检查。", tongue: "舌淡，苔白", pulse: "脉沉弱", pastHistory: "高血压病史", medicationHistory: "氨氯地平5mg每日1次" }),
  },
];

const questionCases = [
  { id: "sparse_digestive", state: baseCase("sparse_digestive", { sex: "男", age: 42, chiefComplaint: "吃完饭总觉得肚子胀", presentHistory: "", tongue: "", pulse: "" }), expected: /进食|早饱|黑便|呕血|消瘦|排便|腹痛/ },
  { id: "colloquial_diarrhea", state: baseCase("colloquial_diarrhea", { sex: "女", age: 46, chiefComplaint: "这阵子一吃东西就胀，还老跑厕所，累得慌", presentHistory: "每天早上吃缬沙坦80毫克1片，没吃别的药；否认妊娠、哺乳及备孕", tongue: "", pulse: "", medicationHistory: "缬沙坦80mg每日1次" }), expected: /病程|次数|夜间|血便|脓血|消瘦|发热/ },
  { id: "pediatric_cough", state: baseCase("pediatric_cough", { sex: "男", age: 7, chiefComplaint: "反复咳嗽、吃饭不好2周", presentHistory: "体重22kg", tongue: "", pulse: "" }), expected: /高热|气促|喘|精神|饮水|尿量|用药|体重/ },
  { id: "sparse_gynecology", state: baseCase("sparse_gynecology", { sex: "女", age: 32, chiefComplaint: "月经总往后拖，量也少", presentHistory: "", tongue: "", pulse: "" }), expected: /末次月经|周期|妊娠|出血|体重|痤疮|乳溢/ },
  { id: "sparse_dermatology", state: baseCase("sparse_dermatology", { sex: "女", age: 25, chiefComplaint: "身上反复起红疹很痒", presentHistory: "", tongue: "", pulse: "" }), expected: /呼吸|面唇|发热|渗液|接触|食物|药物|持续/ },
  { id: "sparse_urology", state: baseCase("sparse_urology", { sex: "男", age: 61, chiefComplaint: "最近晚上老起夜，尿得不顺", presentHistory: "", tongue: "", pulse: "" }), expected: /尿潴留|血尿|发热|腰痛|尿痛|夜尿|用药|病程/ },
];

const knownCaseIds = new Set([...questionCases, ...fullCases].map((item) => item.id).concat("redflag_gi"));
const unknownCaseIds = [...CASE_FILTER].filter((id) => !knownCaseIds.has(id));
if (unknownCaseIds.length > 0) {
  throw new Error(`CLINICAL_MATRIX_CASES contains unknown ids: ${unknownCaseIds.join(",")}`);
}
const expectedCaseIds = [...knownCaseIds].filter(selected);
if (expectedCaseIds.length === 0) throw new Error("clinical matrix selected zero cases");

for (const testCase of questionCases.filter((item) => selected(item.id))) {
  const state = { ...testCase.state, phase: "question", questionRounds: 0, completeness: { level: "A", redFlag: 0.4, infoGain: 0.1, managementImpact: 0.2, answerability: 0.2 } };
  const response = await request("/api/diagnosis/question", state);
  const questionCount = (response.content.match(/(?:^|\n)\s*(?:\*\*)?问题(?:Q|S)?\d+\s*[：:]/g) || []).length;
  const questionTitles = Array.from(response.content.matchAll(/问题\d+[：:]\*{0,2}\s*([^\n]+)/g), (match) => match[1].trim()).join(" / ");
  record(testCase.id, "M02", response.status === 200 && response.replacementApplied && questionCount >= 1 && questionCount <= 2 && testCase.expected.test(response.content), `questions=${questionCount}, finalReplace=${response.replacementApplied}, ${response.elapsedMs}ms${testCase.expected.test(response.content) ? "" : `, titles=${questionTitles}`}`);
  record(testCase.id, "M02交互合同", /追问理由/.test(response.content) && /(?:选项|A[.、：:]|暂无法确认)/.test(response.content), "可点选并允许未知/自由补充");
}

for (const testCase of fullCases.filter((item) => selected(item.id))) {
  const collectInput = [
    `主诉：${testCase.state.chiefComplaint}`,
    `现病史：${testCase.state.symptoms.presentHistory || ""}`,
    `舌象：${testCase.state.tongue || ""}`,
    `脉象：${testCase.state.pulse || ""}`,
  ].join("\n");
  const collect = await request("/api/diagnosis/collect", testCase.state, { userInput: collectInput });
  record(testCase.id, "M01", collect.status === 200 && /病历信息已采集/.test(collect.content), `${collect.elapsedMs}ms`);

  const m03State = { ...testCase.state, phase: "diagnose" };
  const m03 = await request("/api/diagnosis/diagnose", m03State);
  const diagnose = reasoningFrom(m03.content, "diagnose");
  const m03Visible = m03.content.split("<!-- DIAGNOSIS_JSON_START -->")[0];
  record(testCase.id, "M03合同", m03.status === 200 && diagnose && diagnose.formula == null && /^hmac-sha256:/.test(diagnose.contractSignature || ""), `${m03.elapsedMs}ms, heartbeats=${m03.heartbeatCount}`);
  const structuredClinicalText = JSON.stringify(diagnose || {});
  const m03ClinicalOutput = `${m03Visible}\n${structuredClinicalText}`;
  record(testCase.id, "M03领域质量", Boolean(diagnose) && testCase.domain.test(m03ClinicalOutput) && !testCase.forbidden.test(m03ClinicalOutput), diagnose?.overview?.primarySyndrome || "无结构化结果");
  const missingExpectedFacts = testCase.expectedFacts.filter((pattern) => !pattern.test(structuredClinicalText));
  record(testCase.id, "M03事实利用", Boolean(diagnose) && missingExpectedFacts.length === 0, missingExpectedFacts.length > 0
    ? `${missingExpectedFacts.map(String).join("、")}; supportingFacts=${JSON.stringify(diagnose?.westernDiagnosis?.primary?.supportingFacts || [])}`
    : "");
  const westernText = JSON.stringify(diagnose?.westernDiagnosis || {});
  const westernEvidence = diagnose?.westernDiagnosis?.primary?.evidence;
  const westernEvidenceConsistent = westernEvidence?.evidenceLevel === "insufficient"
    ? !westernEvidence?.source
    : Boolean(westernEvidence?.source);
  const westernStructureOk = Boolean(diagnose?.westernDiagnosis?.primary?.name) && testCase.westernPrimary.test(diagnose.westernDiagnosis.primary.name) && (!testCase.westernCoverage || testCase.westernCoverage.test(westernText)) && Array.isArray(diagnose?.westernDiagnosis?.primary?.supportingFacts) && diagnose.westernDiagnosis.primary.supportingFacts.length > 0 && westernEvidenceConsistent;
  record(testCase.id, "M03西医结构", westernStructureOk, `${diagnose?.westernDiagnosis?.primary?.name || "无"}; facts=${diagnose?.westernDiagnosis?.primary?.supportingFacts?.length || 0}; evidence=${westernEvidence?.evidenceLevel || "无"}; source=${westernEvidence?.source || "省略"}${westernStructureOk ? "" : `; supportingFacts=${JSON.stringify(diagnose?.westernDiagnosis?.primary?.supportingFacts || [])}; differentials=${JSON.stringify(diagnose?.westernDiagnosis?.differentials || [])}`}`);
  record(testCase.id, "M03病机链", Array.isArray(diagnose?.pathogenesis?.chain) && diagnose.pathogenesis.chain.length > 0 && diagnose.pathogenesis.chain.every((node) => node.patientFact && node.syndromeEvidence && node.pathogenesis && node.therapyDirection), `nodes=${diagnose?.pathogenesis?.chain?.length || 0}`);
  if (!diagnose) continue;

  const m04State = { ...testCase.state, phase: "prescribe", diagnosis: m03.content, reasoningDiagnose: diagnose, reasoningV2: diagnose };
  const m04 = await request("/api/diagnosis/prescribe", m04State);
  const prescribe = reasoningFrom(m04.content, "prescribe");
  const candidate = prescribe?.formula?.candidates?.[0];
  record(testCase.id, "M04合同", m04.status === 200 && candidate?.herbs?.length >= 4, `${m04.elapsedMs}ms, herbs=${candidate?.herbs?.length || 0}`);
  record(testCase.id, "M04跨阶段", prescribe?.overview?.primarySyndrome === diagnose.overview.primarySyndrome && prescribe?.overview?.overallPathogenesis === diagnose.overview.overallPathogenesis && prescribe?.therapy?.overallPrinciple === diagnose.therapy.overallPrinciple, candidate?.name || "无候选");
  const doseIssues = (candidate?.herbs || []).flatMap((herb) => {
    const match = String(herb.dose || "").match(/^(\d+(?:\.\d+)?)(g|mg)$/i);
    const grams = match ? Number(match[1]) / (match[2].toLowerCase() === "mg" ? 1000 : 1) : NaN;
    const limit = getTcmHerbDoseLimit(herb.name);
    return Number.isFinite(grams) && limit?.min != null && limit.max != null && grams >= limit.min && grams <= limit.max ? [] : [`${herb.name}:${herb.dose}`];
  });
  record(testCase.id, "M04剂量真源", Boolean(candidate) && doseIssues.length === 0, doseIssues.join("、"));
  const pairIssues = findTcmHerbPairIncompatibilities((candidate?.herbs || []).map((herb) => herb.name));
  record(testCase.id, "M04配伍预检", Boolean(candidate) && pairIssues.length === 0, pairIssues.map((item) => `${item.leftDrug}-${item.rightDrug}`).join("、"));
  const projects = prescribe?.nonPharma?.tcmTreatments || [];
  record(testCase.id, "M04治疗项目", projects.length >= testCase.minProjects && projects.length <= 3 && projects.every((item) => item.executable === false && item.clinicianReviewRequired === true && /^P\d+$/.test(item.targetRef) && !/(?:mm|毫升|分钟|深度|放血量|穴位)/.test(item.assessmentPositioning) && (item.containsMedication !== true || item.requiresMedicationAudit === true)), projects.map((item) => `${item.projectName}:${item.availability}`).join("、") || "模型未推荐与本例匹配的机构可用项目");
  if (!prescribe) continue;

  const auditState = { ...m04State, phase: "assess", prescription: m04.content, reasoningPrescribe: prescribe, reasoningV2: prescribe };
  const audit = await request("/api/diagnosis/post-prescription-risk", auditState);
  const issues = Array.isArray(audit.json?.audit?.issues) ? audit.json.audit.issues : [];
  const preventable = issues.filter(isMechanicallyPreventableAuditIssue);
  record(testCase.id, "M05真实审方", audit.status === 200 && audit.json?.audit?.source === "lingxi" && audit.json?.audit?.degraded !== true, `issues=${issues.length}, ${audit.elapsedMs}ms`);
  record(testCase.id, "M05问题标识", issues.every((issue) => typeof issue.issueId === "string" && issue.issueId.length > 0 && issue.issueIdGenerated !== true && !/^LOCAL-/i.test(issue.issueId)), issues.filter((issue) => !issue.issueId || issue.issueIdGenerated === true || /^LOCAL-/i.test(String(issue.issueId))).map((issue) => issue.title).join("、"));
  record(testCase.id, "M05可避免问题", preventable.length === 0, preventable.map((item) => `${item.issueId || item.title}:${item.description || item.title}`).join("、"));
  const assess = await request("/api/diagnosis/assess", { ...auditState, riskAssessment: audit.content });
  record(testCase.id, "M05随访", assess.status === 200 && /随访|复诊|监测|观察/.test(assess.content), `${assess.elapsedMs}ms`);
}

const redFlag = baseCase("redflag_gi", {
  sex: "男", age: 67, chiefComplaint: "上腹痛伴柏油样黑便2天、头晕", presentHistory: "持续黑便，站立时头晕，服阿司匹林100mg每日1次", tongue: "舌淡", pulse: "脉细数", vitals: { T: "36.5℃", P: "118次/分", R: "22次/分", BP: "90/55mmHg" }, medicationHistory: "阿司匹林100mg每日1次",
});
if (selected("redflag_gi")) {
  const redM03 = await request("/api/diagnosis/diagnose", { ...redFlag, phase: "diagnose" });
  const redReasoning = reasoningFrom(redM03.content, "diagnose");
  record("redflag_gi", "M03红旗", redM03.status === 200 && /急诊|消化道出血|循环/.test(redM03.content) && Boolean(redReasoning), `${redM03.elapsedMs}ms`);
  if (redReasoning) {
    const redM04 = await request("/api/diagnosis/prescribe", { ...redFlag, phase: "prescribe", diagnosis: redM03.content, reasoningDiagnose: redReasoning, reasoningV2: redReasoning });
    const noDose = evaluateLimitedNoDose(redM04.content);
    record("redflag_gi", "M04红旗边界", redM04.status === 200 && noDose.ok, `${redM04.elapsedMs}ms; ${JSON.stringify(noDose)}`);
  }
}

const failures = results.filter((item) => !item.ok);
const executedCaseIds = new Set(results.map((item) => item.caseId));
const missingCaseIds = expectedCaseIds.filter((id) => !executedCaseIds.has(id));
if (results.length === 0 || missingCaseIds.length > 0) {
  throw new Error(`clinical matrix execution incomplete; checks=${results.length}; missing=${missingCaseIds.join(",") || "none"}`);
}
console.log(JSON.stringify({ suite: "live-clinical-matrix", checks: results.length, failures: failures.length, failed: failures }, null, 2));
process.exit(failures.length ? 1 : 0);
