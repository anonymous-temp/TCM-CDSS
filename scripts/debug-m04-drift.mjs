// 复现 M04 formula_reference_selection_drift:多次跑 live M03→M04,打印 M03 锁定方名/模式 + M04 结果。
// 服务端日志(dev.log)会打印 expectedNames/actualHerbs 等细节。用法: BASE_URL=… node scripts/debug-m04-drift.mjs [N]
const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const N = Number(process.argv[2] || 4);
const START = "<!-- DIAGNOSIS_JSON_START -->", END = "<!-- DIAGNOSIS_JSON_END -->";
const MARK = "<<<CDSS_STREAM_FINAL>>>";

const benign = {
  id: "m04-drift", phase: "collect", patient: { sex: "女", age: 34 },
  chiefComplaint: "反复入睡困难2月，多梦易醒，日间乏力心悸",
  symptoms: { sleep: "入睡困难，多梦易醒", other: "心悸、纳差、神疲，二便调" },
  tongue: "舌淡红，苔薄白", pulse: "细弱", faceNote: "面色少华，神志清",
  vitals: { T: "36.5℃", P: "74次/分", R: "18次/分", BP: "118/72mmHg" },
  pastHistory: "否认高血压、糖尿病、心脑血管及甲状腺疾病。月经规律，否认妊娠、否认哺乳，无备孕。睡眠呼吸筛查：否认打鼾、否认呼吸暂停，血压正常。",
  medicationHistory: "否认当前用药", allergyHistory: "否认药物及食物过敏",
  completeness: { level: "C", redFlag: 0.8, infoGain: 1, managementImpact: 1, answerability: 1 },
  conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
};

async function callStage(path, caseState) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
    body: JSON.stringify({ caseState }),
  });
  const raw = await res.text();
  let content = "";
  for (const line of raw.split("\n")) { const s = line.trim(); if (!s) continue; try { const o = JSON.parse(s); if (typeof o.content === "string" && o.content !== "[END]") content += o.content; } catch {} }
  const mi = content.lastIndexOf(MARK); if (mi >= 0) content = content.slice(mi + MARK.length);
  return { status: res.status, content };
}
function extractReasoning(c) { const s = c.lastIndexOf(START), e = s >= 0 ? c.indexOf(END, s) : -1; if (s < 0 || e < 0) return null; try { return JSON.parse(c.slice(s + START.length, e).trim()); } catch { return null; } }

let drift = 0, ok = 0, m03fail = 0;
for (let i = 1; i <= N; i++) {
  const m03 = await callStage("/api/diagnosis/diagnose", benign);
  const r = extractReasoning(m03.content);
  if (!r) { m03fail++; console.log(`#${i} M03 失败(无签名辨证)`); continue; }
  const mode = r.overview?.formulaSelectionMode, names = r.overview?.recommendedFormulaNames || [];
  const m04 = await callStage("/api/diagnosis/prescribe", { ...benign, reasoningDiagnose: r });
  const isDrift = /暂不生成候选方药|缺少有效|安全降级|未完成|结构校验/.test(m04.content) || m04.content.length < 400;
  if (isDrift) drift++; else ok++;
  console.log(`#${i} M03锁定: mode=${mode} names=[${names.join("、")}]  →  M04: ${isDrift ? "❌ drift/降级" : "✅ 出方"} (${m04.content.length}字)`);
}
console.log(`\nM03失败 ${m03fail} · M04出方 ${ok} · M04漂移 ${drift}  (共 ${N})`);
