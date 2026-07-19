// 6 条典型病证完整 M03→M04 推理 + 中医临床质量评估
// 跳过 M01/M02(直接给完整 caseState 走 diagnose),目的是评估 M03/M04 临床质量
// 用法: node scripts/regress-typical-6-evaluate.mjs
import fs from "node:fs";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";

function extractStageReasoning(content, stage) {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return null;
  try {
    const r = JSON.parse(content.slice(start + START_MARKER.length, end).trim());
    if (r?.schemaVersion === "tcm-cdss-reasoning-v2" && r.stage === stage) return r;
  } catch {}
  return null;
}

async function callStage(path, caseState) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240000);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseState }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    const ms = Date.now() - t0;
    let content = "";
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    if (json && typeof json === "object" && !Array.isArray(json) && (json.section || json.followup)) {
      content = json.section || json.followup || "";
    } else {
      for (const line of raw.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          const o = JSON.parse(s);
          if (typeof o.content === "string" && o.content !== "[END]") content += o.content;
          if (o.error) content += `\n[ERROR] ${o.error}\n`;
        } catch {}
      }
      const mi = content.lastIndexOf(STREAM_REPLACE_MARKER);
      if (mi >= 0) content = content.slice(mi + STREAM_REPLACE_MARKER.length);
    }
    return { status: res.status, ms, content, json, raw };
  } finally {
    clearTimeout(timer);
  }
}

const COMPLETE = { level: "C", redFlag: 0.85, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 };

const CASES = [
  {
    id: "CASE01-PIXUHAN",
    label: "脾胃虚寒胃痛",
    expected_formula: "理中汤/黄芪建中汤/香砂六君子汤类",
    expected_therapy: "温中健脾,和胃止痛",
    caseSummary: "男 45 岁;主诉胃脘冷痛反复 3 月;现症:胃脘冷痛遇寒加重得温则减、喜按、神疲乏力、纳少便溏;舌淡胖苔白润,脉沉迟;BP 118/75mmHg;否认慢病/过敏/用药。",
    state: {
      id: "case-01", phase: "collect", patient: { sex: "男", age: 45 },
      chiefComplaint: "胃脘冷痛反复 3 月,遇寒加重得温则减",
      symptoms: { stomach: "胃脘冷痛,喜温喜按,遇寒加重得温则减", other: "神疲乏力、纳少便溏" },
      tongue: "舌淡胖,苔白润", pulse: "沉迟", faceNote: "面色萎黄,神疲",
      vitals: { T: "36.4℃", P: "68 次/分", R: "17 次/分", BP: "118/75mmHg" },
      pastHistory: "否认高血压、糖尿病、心脏病、肝病。否认手术史。", allergyHistory: "否认药物食物过敏。", medicationHistory: "否认当前用药。",
      completeness: COMPLETE, conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
    }
  },
  {
    id: "CASE02-GANYANG",
    label: "肝阳上亢头痛",
    expected_formula: "天麻钩藤饮/镇肝熄风汤类",
    expected_therapy: "平肝潜阳,清热息风",
    caseSummary: "男 56 岁;主诉头痛眩晕反复半年;现症:头痛偏两侧、眩晕、烦躁易怒、面红目赤、口苦;舌红苔黄,脉弦有力;BP 150/92mmHg;否认高血压既往用药,无心梗/脑梗史。",
    state: {
      id: "case-02", phase: "collect", patient: { sex: "男", age: 56 },
      chiefComplaint: "头痛眩晕反复半年,烦躁易怒、面红目赤",
      symptoms: { head: "偏侧头痛、眩晕、目赤", other: "烦躁易怒、口苦、面红" },
      tongue: "舌红,苔黄", pulse: "弦有力", faceNote: "面红目赤",
      vitals: { T: "36.7℃", P: "82 次/分", R: "18 次/分", BP: "150/92mmHg" },
      pastHistory: "否认脑梗、心梗、肾病、糖尿病史。", allergyHistory: "否认过敏。", medicationHistory: "否认当前用药。",
      completeness: COMPLETE, conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
    }
  },
  {
    id: "CASE03-SHENYANGXU",
    label: "肾阳虚腰痛",
    expected_formula: "右归丸/金匮肾气丸类",
    expected_therapy: "温补肾阳,强腰膝",
    caseSummary: "男 62 岁;主诉腰膝冷痛 1 年;现症:腰膝冷痛、畏寒肢冷、夜尿频多(4-5 次/夜)、性欲减退;舌淡胖苔白,脉沉迟;BP 130/80mmHg;否认糖尿病。",
    state: {
      id: "case-03", phase: "collect", patient: { sex: "男", age: 62 },
      chiefComplaint: "腰膝冷痛 1 年,畏寒肢冷",
      symptoms: { lumbar: "腰膝冷痛,久立加重,得温则减", other: "畏寒肢冷、夜尿 4-5 次、性欲减退" },
      tongue: "舌淡胖,苔白", pulse: "沉迟", faceNote: "面色苍白,神疲",
      vitals: { T: "36.3℃", P: "66 次/分", R: "16 次/分", BP: "130/80mmHg" },
      pastHistory: "否认糖尿病、肾病、腰椎外伤史。", allergyHistory: "否认过敏。", medicationHistory: "否认当前用药。",
      completeness: COMPLETE, conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
    }
  },
  {
    id: "CASE04-FENGHAN",
    label: "风寒咳嗽",
    expected_formula: "三拗汤/止嗽散/杏苏散类",
    expected_therapy: "疏风散寒,宣肺止咳",
    caseSummary: "女 32 岁;主诉咳嗽 3 天;现症:咳嗽、痰白清稀、恶寒无汗、鼻塞流清涕、头痛身痛;舌淡红苔薄白,脉浮紧;T 37.0℃,无发热高热。",
    state: {
      id: "case-04", phase: "collect", patient: { sex: "女", age: 32 },
      chiefComplaint: "咳嗽 3 天,痰白清稀,伴恶寒无汗",
      symptoms: { cough: "咳嗽阵作、痰白清稀量中", other: "恶寒无汗、鼻塞流清涕、头痛身痛" },
      tongue: "舌淡红,苔薄白", pulse: "浮紧", faceNote: "面色如常",
      vitals: { T: "37.0℃", P: "76 次/分", R: "18 次/分", BP: "115/72mmHg" },
      pastHistory: "否认哮喘、COPD、心脏病。月经规律,否认妊娠哺乳。", allergyHistory: "否认过敏。", medicationHistory: "否认当前用药。",
      completeness: COMPLETE, conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
    }
  },
  {
    id: "CASE05-XINPIXU",
    label: "心脾两虚失眠",
    expected_formula: "归脾汤类",
    expected_therapy: "补益心脾,养血安神",
    caseSummary: "女 41 岁;主诉失眠多梦伴心悸健忘半年;现症:入睡困难、多梦易醒、心悸健忘、食少便溏、神疲乏力、面色萎黄;舌淡苔白,脉细弱;BP 115/72mmHg;OSA 否认打鼾/呼吸暂停/血压正常。",
    state: {
      id: "case-05", phase: "collect", patient: { sex: "女", age: 41 },
      chiefComplaint: "失眠多梦伴心悸健忘半年",
      symptoms: { sleep: "入睡困难、多梦易醒", other: "心悸、健忘、食少便溏、神疲乏力" },
      tongue: "舌淡,苔白", pulse: "细弱", faceNote: "面色萎黄,神疲",
      vitals: { T: "36.5℃", P: "74 次/分", R: "18 次/分", BP: "115/72mmHg" },
      pastHistory: "否认心脑血管病、糖尿病、甲亢。月经规律,否认妊娠哺乳,无备孕。睡眠呼吸筛查:否认打鼾、否认呼吸暂停或憋醒,血压正常,OSA 低危。",
      allergyHistory: "否认药物食物过敏。", medicationHistory: "否认当前用药。",
      completeness: COMPLETE, conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
    }
  },
  {
    id: "CASE06-SHIREHUANGDAN",
    label: "湿热黄疸(阳黄)",
    expected_formula: "茵陈蒿汤类",
    expected_therapy: "清热利湿,利胆退黄",
    caseSummary: "男 38 岁;主诉身目黄染 1 周;现症:身目黄染鲜明、口干口苦、恶心呕吐、纳呆、小便短赤、大便秘结;舌红苔黄腻,脉弦数;BP 122/78;否认肝炎史。",
    state: {
      id: "case-06", phase: "collect", patient: { sex: "男", age: 38 },
      chiefComplaint: "身目黄染 1 周,口干口苦",
      symptoms: { jaundice: "身目黄染鲜明如橘子色", other: "口干口苦、恶心呕吐、纳呆、小便短赤、大便秘结" },
      tongue: "舌红,苔黄腻", pulse: "弦数", faceNote: "面目黄染",
      vitals: { T: "37.2℃", P: "84 次/分", R: "18 次/分", BP: "122/78mmHg" },
      pastHistory: "否认肝炎、胆石症、胆道手术史。", allergyHistory: "否认过敏。", medicationHistory: "否认当前用药。",
      completeness: COMPLETE, conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
    }
  },
];

async function runOne(c) {
  console.log(`\n========== ${c.id} | ${c.label} ==========`);
  console.log(`期望方: ${c.expected_formula} | 期望治法: ${c.expected_therapy}`);
  // M03
  const m03 = await callStage("/api/diagnosis/diagnose", c.state);
  const m03Len = m03.content.length;
  const signed = extractStageReasoning(m03.content, "diagnose");
  console.log(`M03: ${m03.status} in ${m03.ms}ms, len=${m03Len}, signedReasoning=${signed ? "yes" : "NO"}`);
  if (m03.status !== 200) {
    console.log(`M03 错误: ${m03.content.slice(0, 300)}`);
    return { ...c, m03, m04: null, signed: null };
  }
  // M04 with signed reasoning
  const m04state = { ...c.state, reasoningDiagnose: signed, phase: "prescribe" };
  const m04 = await callStage("/api/diagnosis/prescribe", m04state);
  console.log(`M04: ${m04.status} in ${m04.ms}ms, len=${m04.content.length}`);
  if (m04.status !== 200) console.log(`M04 错误: ${m04.content.slice(0, 300)}`);
  return { ...c, m03, m04, signed };
}

const results = [];
for (const c of CASES) {
  try {
    const r = await runOne(c);
    results.push(r);
    // Save full text per case
    const filename = `/tmp/${r.id}-full.txt`;
    const text = `=== ${r.id} | ${r.label} ===\n病例摘要:${r.caseSummary}\n期望方:${r.expected_formula}\n期望治法:${r.expected_therapy}\n\n--- M03 辨病辨证 ---\n${r.m03.content}\n\n--- M04 候选方药 ---\n${r.m04?.content || "(M04 未产出)"}\n`;
    fs.writeFileSync(filename, text);
    console.log(`saved → ${filename}`);
  } catch (e) {
    console.error(`case ${c.id} failed:`, e.message);
    results.push({ ...c, error: e.message });
  }
}

// Summary
console.log("\n\n========= 总结 =========");
for (const r of results) {
  console.log(`\n--- ${r.id} | ${r.label} ---`);
  console.log(`  期望: ${r.expected_formula}`);
  console.log(`  M03 status=${r.m03?.status} len=${r.m03?.content?.length} ms=${r.m03?.ms}`);
  console.log(`  M04 status=${r.m04?.status} len=${r.m04?.content?.length} ms=${r.m04?.ms}`);
  console.log(`  signed: ${r.signed ? "yes" : "NO"}`);
}
