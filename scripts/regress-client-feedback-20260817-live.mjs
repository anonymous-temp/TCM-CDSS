/** 当前部署版的甲方 8.5 / 8.11 同例端到端验收。 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const CUSTOMER_ID = process.env.CDSS_CUSTOMER_ID || "";
const OUT = process.env.OUT || "artifacts/client-feedback-20260817-live.json";
if (!TOKEN) throw new Error("CDSS_API_TOKEN required");
if (!CUSTOMER_ID) throw new Error("CDSS_CUSTOMER_ID required");

const caseState = {
  id: `client-feedback-20260817-${Date.now()}`,
  customerId: CUSTOMER_ID,
  phase: "diagnose",
  patient: { sex: "女", age: 24 },
  chiefComplaint: "恶寒发热、鼻塞流涕2+天",
  symptoms: {
    presentHistory: "2+天前患者淋雨后出现恶寒发热，恶寒重发热轻，伴鼻塞流清涕，稍有咳嗽，无汗，精神饮食尚可，二便调，睡眠欠佳。",
    supplement: "恶寒重发热轻，无汗，脉浮紧。",
  },
  tongue: "舌淡红，苔薄白。",
  pulse: "脉浮紧。",
  faceNote: "面色正常。",
  vitals: { T: "37.5℃", P: "80次/分", R: "18次/分", BP: "110/78mmHg" },
  pastHistory: "既往体健。",
  medicationHistory: "发病后未服用药物。",
  allergyHistory: "否认药物及食物过敏史。",
  conversation: [], questionRounds: 1, maxQuestionRounds: 1,
  diagnosis: "", prescription: "", riskAssessment: "",
};

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
  const startMark = "<!-- DIAGNOSIS_JSON_START -->";
  const endMark = "<!-- DIAGNOSIS_JSON_END -->";
  const start = content.lastIndexOf(startMark);
  const end = start >= 0 ? content.indexOf(endMark, start) : -1;
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(content.slice(start + startMark.length, end).trim()); } catch { return null; }
}

async function call(stage, state) {
  const startedAt = Date.now();
  const response = await fetch(`${BASE_URL}/api/diagnosis/${stage}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cdss-api-token": TOKEN,
      "x-cdss-customer-id": CUSTOMER_ID,
    },
    body: JSON.stringify({ caseState: state }),
    signal: AbortSignal.timeout(220_000),
  });
  const raw = await response.text();
  const stream = consume(raw);
  return { status: response.status, ms: Date.now() - startedAt, ...stream, reasoning: reasoningOf(stream.content) };
}

const m03 = await call("diagnose", caseState);
const m04 = m03.reasoning
  ? await call("prescribe", { ...caseState, phase: "prescribe", diagnosis: m03.content, reasoningDiagnose: m03.reasoning, reasoningV2: m03.reasoning })
  : { status: 0, ms: 0, content: "", error: "M03 reasoning missing", sawEnd: false, reasoning: null };

const failures = [];
const check = (name, condition, detail = "") => { if (!condition) failures.push({ name, detail }); };
check("M03 HTTP/END/contract", m03.status === 200 && m03.sawEnd && m03.reasoning, `status=${m03.status} error=${m03.error}`);
check("M04 HTTP/END/contract", m04.status === 200 && m04.sawEnd && m04.reasoning, `status=${m04.status} error=${m04.error}`);

if (m03.reasoning) {
  const r = m03.reasoning;
  const basis = (r.overview?.primarySyndromeBasis || []).join("；");
  const rationale = r.overview?.tcmDiagnosticRationale || "";
  const chainEvidence = (r.pathogenesis?.chain || []).flatMap((item) => [item.patientFact, item.syndromeEvidence]).join("；");
  check("主证候为风寒表证", /风寒.*表|太阳伤寒/.test(r.overview?.primarySyndrome || ""), r.overview?.primarySyndrome);
  for (const [label, pattern] of [["无汗", /无汗/], ["脉浮紧", /脉(?:象[:：]?)?浮紧|脉浮而紧/]]) {
    check(`${label}进入主证依据`, pattern.test(basis), basis);
    check(`${label}进入辨证推理`, pattern.test(rationale), rationale);
    check(`${label}进入病机链`, pattern.test(chainEvidence), chainEvidence);
  }
  const mechanisms = [r.overview?.overallPathogenesis, r.pathogenesis?.summary, r.pathogenesis?.caseRelationship?.relationship,
    ...(r.pathogenesis?.chain || []).map((item) => item.pathogenesis)].filter(Boolean);
  check("病机无事实状态模板", mechanisms.every((text) => !/病历已记录/.test(text)), mechanisms.join("｜"));
  check("治则有本例信息", !/^(?:正治法?|反治法?|治疗本病)$/.test(r.therapy?.overallPrinciple || ""), r.therapy?.overallPrinciple);
  const westernPrimary = r.westernDiagnosis?.primary;
  check("西医依据无一般状态填充", !(westernPrimary?.supportingFacts || []).some((fact) => /精神饮食尚可|二便调/.test(fact)),
    (westernPrimary?.supportingFacts || []).join("｜"));
  check("西医主诊断使用规范 ICD 名称", westernPrimary?.name === "急性上呼吸道感染" && westernPrimary?.coding?.code === "J06.900",
    JSON.stringify({ name: westernPrimary?.name, coding: westernPrimary?.coding }));
  const diagnosisReference = westernPrimary?.guidelineReferences?.[0];
  check("西医主诊断引用匹配的标准文献", diagnosisReference?.evidenceId === "EVID-GUIDE-925" &&
    /急性上呼吸道感染基层诊疗指南/.test(diagnosisReference?.citation || "") &&
    /^https:\/\//.test(diagnosisReference?.url || ""), JSON.stringify(diagnosisReference));
}

if (m04.reasoning) {
  const candidate = m04.reasoning.formula?.candidates?.[0];
  const roles = Object.fromEntries((candidate?.herbs || []).map((herb) => [herb.name, herb.role]));
  const almondNames = ["苦杏仁", "杏仁"].filter((name) => Object.hasOwn(roles, name));
  const licoriceNames = ["炙甘草", "甘草"].filter((name) => Object.hasOwn(roles, name));
  const base = candidate?.baseFormulas?.[0];
  check("首选麻黄汤", /麻黄汤/.test(candidate?.name || ""), candidate?.name);
  check("麻黄汤来源为伤寒论四味", base?.source === "《伤寒论》" && base?.totalIngredientCount === 4, JSON.stringify(base));
  check("麻黄汤角色正确", roles.麻黄 === "君" && roles.桂枝 === "臣" &&
    almondNames.length === 1 && roles[almondNames[0]] === "佐" &&
    licoriceNames.length === 1 && roles[licoriceNames[0]] === "使", JSON.stringify(roles));
  check("方义无占位", !/具体配伍作用需医生结合方义复核/.test(candidate?.formulaAnalysis || ""), candidate?.formulaAnalysis);
  check("解表剂武火短煎", /武火急煎/.test(candidate?.decoction?.method || "") && candidate?.decoction?.firstDecoctionMinutes <= 15, candidate?.decoction?.method);
  const acupuncture = (m04.reasoning.nonPharma?.tcmTreatments || []).find((item) => item.projectCode === "acupuncture");
  if (acupuncture?.protocolStatus === "assessment_only_no_patient_specific_protocol") {
    check("针刺评估态不展示未治理穴位", (acupuncture.suggestedSitesOrPoints || []).length === 0,
      (acupuncture.suggestedSitesOrPoints || []).join("、"));
  }
}

const result = {
  suite: "client-feedback-20260817-live",
  baseUrl: BASE_URL,
  timingsMs: { m03: m03.ms, m04: m04.ms, total: m03.ms + m04.ms },
  statuses: { m03: m03.status, m04: m04.status },
  failures,
  outputs: {
    m03: m03.reasoning,
    m04: m04.reasoning,
  },
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ suite: result.suite, timingsMs: result.timingsMs, statuses: result.statuses, failures: failures.length }, null, 2));
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
