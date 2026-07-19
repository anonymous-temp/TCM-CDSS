// 深度质量回归:真实跑通 M03→M04→M05 全链 + LLM-as-judge 临床质量评分。
// 用法: BASE_URL=… CDSS_API_TOKEN=… OPENAI_API_KEY=… node scripts/regress-quality-deep.mjs
//
// M04 消费的是 **真实 live-M03** 的服务端签名辨证(而非测试侧伪造签名):跑完 M03 后,直接从其输出
// 流里抽取服务端已 HMAC 签名的结构化辨证块(sentinel 之间),原样带入 M04——与浏览器端流程完全一致。
// 因此本 harness 无需 jiti / server-only / 任何签名密钥;签名由服务端在 M03 阶段完成。

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

// 从 M03 最终正文中抽取服务端签名后的结构化辨证(reasoningDiagnose)。抽不到即视为 M03 被截断/未闭合。
function extractStageReasoning(content, stage) {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return null;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim());
    if (reasoning?.schemaVersion === "tcm-cdss-reasoning-v2" && reasoning.stage === stage) return reasoning;
  } catch { /* 结构化块未闭合 */ }
  return null;
}

function extractSignedReasoning(m03Content) {
  const reasoning = extractStageReasoning(m03Content, "diagnose");
  return reasoning && typeof reasoning.contractSignature === "string" ? reasoning : null;
}

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";
const JUDGE_MODEL = process.env.OPENAI_MODEL || "deepseek-v4-flash";
const JUDGE_BASE = (process.env.OPENAI_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const JUDGE_KEY = process.env.OPENAI_API_KEY || "";
const JUDGE_MIN_AVG = Number(process.env.JUDGE_MIN_AVG || 3.5);   // 平均分阈值(0-5)
const JUDGE_MIN_DIM = Number(process.env.JUDGE_MIN_DIM || 2);     // 单维最低分

const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  << " + detail}`); };

async function callStage(path, caseState) {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
    body: JSON.stringify({ caseState }),
  });
  const raw = await res.text();
  const ms = Date.now() - t0;
  // NDJSON 或 JSON(assess/post-risk 返回 JSON 对象)
  let content = "", json = null;
  try { json = JSON.parse(raw); } catch { /* stream */ }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    content = json.section || json.followup || "";
  } else {
    for (const line of raw.split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const o = JSON.parse(s); if (typeof o.content === "string" && o.content !== "[END]") content += o.content; } catch { /* */ }
    }
    const mi = content.lastIndexOf(STREAM_REPLACE_MARKER);
    if (mi >= 0) content = content.slice(mi + STREAM_REPLACE_MARKER.length);
  }
  return { status: res.status, ms, content, json, raw };
}

async function judge(kind, caseSummary, output, dimensions) {
  if (!JUDGE_KEY) return { skipped: true };
  const sys = "你是资深中医临床质量评审专家。严格、保守打分,只输出一个 JSON 对象,不要解释。";
  const user = [
    `请对下面这段【${kind}】输出做临床质量评分。病例摘要:${caseSummary}`,
    `按维度打分(每维 0-5 整数,5 最好),并给出 overall(0-5)与 issues(字符串数组,列出实质问题)。`,
    `维度:${dimensions.map((d) => `"${d}"`).join("、")}`,
    `输出格式:{"scores":{<维度>:<0-5>,...},"overall":<0-5>,"issues":[...]}`,
    "评分硬约束:凡臆造患者未提供的症状/舌脉/检查、越安全边界开方、伪造证据出处、病机-治法-方药明显不闭环,相关维度必须≤2。",
    "",
    "【待评输出】",
    output.slice(0, 6000),
  ].join("\n");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(`${JUDGE_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${JUDGE_KEY}` },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        temperature: 0,
        max_tokens: 1800,
        response_format: { type: "json_object" },
        reasoning_effort: "low",
      }),
    });
    if (!res.ok) continue;
    const body = await res.json();
    const raw = body?.choices?.[0]?.message?.content || "";
    let parsed; try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const scores = parsed?.scores;
    if (scores && dimensions.every((dimension) => Number.isFinite(scores[dimension]))) return parsed;
  }
  return { invalid: true, scores: {}, overall: null, issues: ["质量判官未返回有效评分 JSON"] };
}

function scoreReport(label, j) {
  if (!j || j.skipped) { console.log(`  [judge:${label}] skipped (no OPENAI_API_KEY)`); return { ok: true, skipped: true }; }
  const scores = j.scores || {};
  const vals = Object.values(scores).filter((v) => typeof v === "number");
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const minDim = vals.length ? Math.min(...vals) : 0;
  console.log(`  [judge:${label}] avg=${avg.toFixed(2)} min=${minDim} overall=${j.overall} scores=${JSON.stringify(scores)}${j.issues?.length ? " issues=" + JSON.stringify(j.issues).slice(0, 300) : ""}`);
  return { ok: avg >= JUDGE_MIN_AVG && minDim >= JUDGE_MIN_DIM, avg, minDim };
}

const COMPLETE = { level: "C", redFlag: 0.8, infoGain: 1, managementImpact: 1, answerability: 1 };
const benign = {
  id: "deep-benign", phase: "collect", patient: { sex: "女", age: 34 },
  chiefComplaint: "反复入睡困难2月，多梦易醒，日间乏力心悸",
  symptoms: { sleep: "入睡困难，多梦易醒", other: "心悸、纳差、神疲" },
  tongue: "舌淡红，苔薄白", pulse: "细弱", faceNote: "面色少华，神志清",
  vitals: { T: "36.5℃", P: "74次/分", R: "18次/分", BP: "118/72mmHg" },
  // 失眠病例进入“剂量级处方(M04)”前,确定性安全门要求先做 OSA 风险筛查(打鼾/呼吸暂停/血压)。
  // 放在既往史(而非现症)里、且只用与“心脾两虚”辨证无关的 OSA 专属阴性项,既满足门控、又不会被
  // 模型编入病机链造成极性接地冲突(日间嗜睡/困倦会与患者本有的“日间乏力/神疲”撞极性,故不写)。
  pastHistory: "否认严重心脑血管疾病、糖尿病、甲状腺疾病。月经规律，否认妊娠、否认哺乳，无备孕计划。睡眠呼吸筛查：否认打鼾、否认睡眠呼吸暂停或憋醒，血压正常(118/72mmHg)，OSA低危。",
  medicationHistory: "否认当前用药", allergyHistory: "否认药物过敏",
  completeness: COMPLETE, conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
};
// 判官必须拿到**全部**医生提供的四诊事实,否则会把本就提供的症状(心悸/纳差/神疲/面色少华)误判为“臆造”。
const CASE_SUMMARY = "【以下为医生提供的全部四诊信息;判断模型是否越界/幻觉只以此为准】34岁女性;主诉:反复入睡困难2月、多梦易醒、日间乏力;伴随:心悸、纳差、神疲;睡眠呼吸筛查:否认打鼾/呼吸暂停,血压正常,OSA低危;舌:舌淡红、苔薄白;脉:细弱;面象:面色少华、神志清;既往:否认心脑血管/糖尿病/甲状腺病,月经规律、否认妊娠哺乳、无备孕;否认过敏;否认当前用药;无急危重红旗。";

console.log(`BASE_URL=${BASE_URL}  judge=${JUDGE_KEY ? JUDGE_MODEL : "OFF"}  阈值 avg≥${JUDGE_MIN_AVG} minDim≥${JUDGE_MIN_DIM}\n`);

// —— M03 live + judge ——(同一 case id 贯穿全链,与真实门诊单次就诊一致)
console.log("=== M03 辨证(live)+ 深度质量评分 ===");
const m03 = await callStage("/api/diagnosis/diagnose", benign);
check("M03 HTTP 200", m03.status === 200, `status=${m03.status}`);
check("M03 输出成规模", m03.content.length > 300, `${m03.content.length}`);
const jM03 = await judge("M03辨证", CASE_SUMMARY, m03.content, ["辨证准确性", "病机链完整性", "治法对应病机", "无越界或幻觉", "临床可执行性"]);
check("M03 深度质量达标", scoreReport("M03", jM03).ok, "见上分数");
console.log(`  ↳ ${m03.ms}ms\n`);

// —— M04 live:消费**真实 live-M03**的服务端签名辨证 + judge ——
console.log("=== M04 候选方药(live, 串真实 M03 签名辨证)+ 深度质量评分 ===");
// 从 M03 输出流里抽取服务端已签名的结构化辨证,原样带入 M04(临床输入/case id 与 M03 完全一致 → 签名校验通过)。
const signedReasoning = extractSignedReasoning(m03.content);
check("M03 输出含服务端签名的结构化辨证", signedReasoning != null,
  "未从 M03 输出抽到已签名 reasoningDiagnose(M03 被截断或结构化块未闭合)");
let m04Content = "";
let m04Reasoning = null;
if (signedReasoning) {
  const m04State = { ...benign, diagnosis: m03.content, reasoningDiagnose: signedReasoning, reasoningV2: signedReasoning };
  const m04 = await callStage("/api/diagnosis/prescribe", m04State);
  check("M04 HTTP 200", m04.status === 200, `status=${m04.status} ${m04.raw.slice(0, 120)}`);
  check("M04 输出含药味/剂量/君臣佐使", /(君药|臣药|佐药|使药|\d+\s*g\b|饮片|方药)/.test(m04.content), m04.content.slice(0, 160));
  check("M04 输出成规模", m04.content.length > 300, `${m04.content.length}`);
  const jM04 = await judge("M04处方", CASE_SUMMARY + " M03已辨为心脾两虚、治法健脾益气养血安神。", m04.content, ["方药覆盖治法(闭环)", "剂量合理性", "君臣佐使结构", "配伍与安全意识", "无幻觉药或越界"]);
  check("M04 深度质量达标", scoreReport("M04", jM04).ok, "见上分数");
  console.log(`  ↳ ${m04.ms}ms\n`);
  m04Content = m04.content;
  m04Reasoning = extractStageReasoning(m04.content, "prescribe");
  check("M04 输出含结构化处方合同", m04Reasoning?.formula?.candidates?.[0]?.herbs?.length > 0,
    "未从 M04 最终输出抽取到结构化药味，后续审方不能降级为 Markdown 猜测");
}

// —— M05 风险随访(确定性, 消费处方)——
console.log("=== M05 风险随访(post-prescription-risk → assess) ===");
const m05State = {
  ...benign,
  diagnosis: m03.content,
  reasoningDiagnose: signedReasoning || undefined,
  prescription: m04Content,
  reasoningPrescribe: m04Reasoning || undefined,
  reasoningV2: m04Reasoning || signedReasoning || undefined,
};
const postRisk = await callStage("/api/diagnosis/post-prescription-risk", m05State);
check("post-risk HTTP 200", postRisk.status === 200, `status=${postRisk.status}`);
check("post-risk 有审方结论", /(审方|风险|复核|人工)/.test(postRisk.content), postRisk.content.slice(0, 160));
check("post-risk 调用真实合理用药审方", postRisk.json?.audit?.source === "lingxi" && postRisk.json?.audit?.degraded !== true,
  JSON.stringify(postRisk.json?.audit || {}).slice(0, 240));
const auditIssues = Array.isArray(postRisk.json?.audit?.issues) ? postRisk.json.audit.issues : [];
check("post-risk 每条风险均有 issueId", auditIssues.every((issue) => typeof issue?.issueId === "string" && issue.issueId.trim().length > 0),
  JSON.stringify(auditIssues).slice(0, 300));
const assessState = { ...m05State, riskAssessment: postRisk.content };
const assess = await callStage("/api/diagnosis/assess", assessState);
check("M05 assess HTTP 200", assess.status === 200, `status=${assess.status}`);
check("M05 输出含随访/复诊/观察", /(随访|复诊|观察|首次复诊|时间轴|转诊)/.test(assess.content), assess.content.slice(0, 160));
console.log(`  ↳ post-risk ${postRisk.ms}ms, assess ${assess.ms}ms\n`);

// —— HIS 出口:验证同一份受签名、结构化、已审方候选能形成可交付方案 ——
console.log("=== HIS 辅助方案出口 ===");
const his = await callStage("/api/diagnosis/his-scheme", { ...assessState, riskAssessment: [postRisk.content, assess.content].filter(Boolean).join("\n\n") });
check("HIS HTTP 200", his.status === 200, `status=${his.status} ${his.raw.slice(0, 180)}`);
check("HIS 返回结构化辅助方案", Boolean(his.json && (his.json.scheme || his.json.prescription || his.json.candidates || his.json.caseId)), his.raw.slice(0, 240));

const failed = results.filter((x) => !x.ok);
console.log(JSON.stringify({ suite: "quality-deep", total: results.length, failures: failed.length, failed: failed.map((f) => f.name) }, null, 2));
process.exit(failed.length ? 1 : 0);
