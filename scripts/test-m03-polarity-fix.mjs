// 针对性验证:带"问诊阴性项"(无自汗盗汗/无明显寒热)的详细病例——修复前 M03 反复因
// m03_patient_fact_ungrounded_*_polarity 失败。跑 N 次,统计成功产出已签名辨证的比例。
// 用法: BASE_URL=… CDSS_API_TOKEN=… node scripts/test-m03-polarity-fix.mjs [次数]
const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const RUNS = Number(process.argv[2] || 4);
const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";

// 关键触发项:symptoms.other 里含被否认的 自汗/盗汗/寒热——心脾两虚辨证模型易把"自汗"写进病机链,
// 与病历极性冲突 → 修复前被抗幻觉合同拒绝。
const caseState = {
  id: "polarity-fix", phase: "collect", patient: { sex: "女", age: 34 },
  chiefComplaint: "反复入睡困难2月，多梦易醒，日间乏力心悸",
  symptoms: {
    sleep: "入睡困难，多梦易醒",
    other: "心悸、纳差、神疲；无明显寒热，无自汗盗汗，二便调，情志偶有波动，无疼痛，无腹部不适",
  },
  tongue: "舌淡红，苔薄白", pulse: "细弱", faceNote: "面色少华，神志清，形体适中",
  vitals: { T: "36.5℃", P: "74次/分", R: "18次/分", BP: "118/72mmHg" },
  pastHistory: "否认高血压、糖尿病、心脑血管及甲状腺疾病。月经规律，否认妊娠、否认哺乳，无备孕计划。睡眠呼吸筛查：否认打鼾、否认睡眠呼吸暂停或憋醒，血压正常，OSA低危。",
  medicationHistory: "否认当前用药", allergyHistory: "否认药物及食物过敏",
  completeness: { level: "C", redFlag: 0.8, infoGain: 1, managementImpact: 1, answerability: 1 },
  conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
};

async function runOnce() {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/api/diagnosis/diagnose`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
    body: JSON.stringify({ caseState }),
  });
  const raw = await res.text();
  let content = "";
  for (const line of raw.split("\n")) {
    const s = line.trim(); if (!s) continue;
    try { const o = JSON.parse(s); if (typeof o.content === "string" && o.content !== "[END]") content += o.content; } catch { /* */ }
  }
  const mi = content.lastIndexOf(STREAM_REPLACE_MARKER);
  if (mi >= 0) content = content.slice(mi + STREAM_REPLACE_MARKER.length);
  const ms = Date.now() - t0;
  // 成功 = 产出了已签名的结构化辨证(sentinel 块存在且解析出证候 + 病机链),而非截断兜底。
  const s = content.lastIndexOf(START), e = s >= 0 ? content.indexOf(END, s) : -1;
  let ok = false, syndrome = "", note = "";
  if (s >= 0 && e > s) {
    try {
      const r = JSON.parse(content.slice(s + START.length, e).trim());
      syndrome = r?.overview?.primarySyndrome || "";
      const chainLen = r?.pathogenesis?.chain?.length || 0;
      ok = r?.stage === "diagnose" && !!syndrome && chainLen > 0 && typeof r?.contractSignature === "string";
      if (!ok) note = `stage=${r?.stage} syndrome="${syndrome}" chain=${chainLen} signed=${typeof r?.contractSignature === "string"}`;
    } catch { note = "sentinel JSON 解析失败"; }
  } else {
    note = /截断|未闭合|信息不足|安全/.test(content) ? "截断/兜底(未产出辨证)" : "无 sentinel 块";
  }
  return { ok, ms, syndrome, note, status: res.status };
}

console.log(`BASE_URL=${BASE_URL}  跑 ${RUNS} 次  (验证 M03 极性接地修复)\n`);
let pass = 0;
for (let i = 1; i <= RUNS; i++) {
  const r = await runOnce();
  if (r.ok) pass++;
  console.log(`  #${i}  ${r.ok ? "✅ 成功" : "❌ 失败"}  ${r.ms}ms  HTTP ${r.status}  ${r.ok ? `证候="${r.syndrome}"` : `→ ${r.note}`}`);
}
console.log(`\n结果:${pass}/${RUNS} 成功产出辨证。` + (pass === RUNS ? " 全部通过 ✅" : pass > 0 ? " 部分通过 ⚠️" : " 全部失败 ❌"));
process.exit(pass === RUNS ? 0 : 1);
