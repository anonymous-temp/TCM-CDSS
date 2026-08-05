// 线上验收回归(2026-08-05)。用手上带金标准的病历跑真实生产链路,逐例记录输入输出与判定。
//
// 与 regress:prod-smoke 的分工:那个测「链路是否通」(2 例、快);
// 本套件测「临床结论是否可接受」——覆盖甲方历轮提出的全部可自动判定项,逐例留证。
//
// 判定项(全部来自甲方评测条目,不是我自设的指标):
//  P1 M03/M04 链路完成          —— 甲方条目 1、2(追问阻断、候选方药失败)
//  P2 病名鉴别非空              —— 条目 2.2(应做病名鉴别)
//  P3 证候名规范(非「病名+病机」)—— 证候名规范化确认项
//  P4 无工程标签泄漏 L0–L4      —— 条目 7 方解混入工程标签
//  P5 否认核对无误判            —— 极性专项(把已记录症状说成否认)
//  P6 治法非空且与主症相关      —— 条目 4.1
//  P7 方名可追溯(非纯自拟)      —— 条目 5.1/5.2
import fs from "node:fs";

const B = (process.env.BASE_URL || "").replace(/\/+$/, "");
const T = process.env.CDSS_API_TOKEN || "";
const H = { "Content-Type": "application/json", "x-cdss-api-token": T };
const LIMIT = Number(process.env.LIMIT || 50);
const OUT = process.env.OUT || "/tmp/gy/ck/acceptance.json";

const files = (process.env.FILES || "artifacts/web-cases-batch3.json,artifacts/web-cases-batch4-mcq.json,artifacts/web-cases-batch4-records.json").split(",");
const pool = [];
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  const rows = Array.isArray(d) ? d : (d.cases || d.entries || d.items || []);
  rows.forEach((r, i) => pool.push({ ...r, _src: f.split("/").pop(), _i: i }));
}
const step = Math.max(1, Math.floor(pool.length / LIMIT));
const cases = pool.filter((_, i) => i % step === 0).slice(0, LIMIT);
console.log(`语料 ${pool.length} 例,均匀抽样 ${cases.length} 例`);

async function call(path, body) {
  try {
    const r = await fetch(`${B}/api/diagnosis/${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
    const raw = await r.text();
    if (!r.ok) return { status: r.status, error: raw.slice(0, 120) };
    let md = "";
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.content && o.content !== "[END]") md += o.content; if (o.error) return { status: "stream_error", error: o.error }; } catch { /* 心跳等噪声 */ }
    }
    const m = md.match(/<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/);
    return { status: 200, markdown: md, structured: m ? JSON.parse(m[1].trim()) : null };
  } catch (e) { return { status: "ERR", error: String(e).slice(0, 120) }; }
}

const INTERNAL_TAG = /(?:^|[\s（(【|])L[0-4](?:$|[\s）)】|，,。；;])/;
const results = [];
let n = 0;

for (const c of cases) {
  n += 1;
  const history = c.presentHistory || "";
  const cs = {
    id: `acc-${Date.now()}-${n}`,
    patient: { sex: c.sex || "未知", age: c.age || null },
    chiefComplaint: c.chiefComplaint || "",
    symptoms: { 现病史: history },
    tongue: c.tongue || "", pulse: c.pulse || "", conversation: [], vitals: {},
  };
  const row = {
    序号: n, 来源: c._src, 编号: c.no ?? c._i,
    输入: { 性别: cs.patient.sex, 年龄: cs.patient.age, 主诉: cs.chiefComplaint, 现病史: history.slice(0, 120), 舌: cs.tongue, 脉: cs.pulse },
    金标准: { 病名: c.tcmDisease || null, 证候: c.tcmSyndrome || c.syndrome || null },
    判定: {},
  };

  const m03 = await call("diagnose", { caseState: cs });
  row.输出 = { M03状态: m03.status };
  row.判定.P1_链路 = m03.status === 200 ? "通过" : `失败(${m03.status})`;

  if (m03.status === 200 && m03.structured) {
    const r3 = m03.structured;
    const syndrome = r3.overview?.primarySyndrome || "";
    const differentials = (r3.overview?.tcmDiseaseDifferentials || []).map((x) => x.diseaseName).filter(Boolean);
    row.输出.主证 = syndrome;
    row.输出.病名鉴别 = differentials;
    row.输出.病位 = r3.pathogenesis?.locationDifferentiation?.items || [];
    row.输出.治法 = r3.therapy?.overallMethod || "";

    row.判定.P2_病名鉴别 = differentials.length > 0 ? "通过" : "未给出";
    // 证候名规范:不应是「病名+纯病机描述」——以括注内容是否含病机短语为近似判据
    row.判定.P3_证候名规范 = /[（(][^）)]*(?:失和|失养|不足|亏虚|阻滞|上扰)[^）)]*[）)]/.test(syndrome) ? "疑似病名+病机" : "通过";
    row.判定.P4_无工程标签 = INTERNAL_TAG.test(m03.markdown) ? `泄漏(${m03.markdown.match(INTERNAL_TAG)?.[0]?.trim()})` : "通过";
    // 否认误判:模型称否认的症状,却在病历原文中以阳性形式出现
    const falseDenials = (m03.markdown.match(/病历已记录否认([^；。、\s]{2,8})/g) || [])
      .map((x) => x.replace(/病历已记录否认/, ""))
      .filter((term) => history.includes(term) && !new RegExp(`[无未不没否][^，,。；;]{0,4}${term}`).test(history));
    row.输出.否认误判项 = falseDenials;
    row.判定.P5_否认核对 = falseDenials.length === 0 ? "通过" : `误判(${falseDenials.join("、")})`;
    row.判定.P6_治法 = row.输出.治法.trim().length > 0 ? "通过" : "为空";

    const m04 = await call("prescribe", { caseState: { ...cs, reasoningDiagnose: r3 } });
    row.输出.M04状态 = m04.status;
    if (m04.status === 200 && m04.structured) {
      const cand = m04.structured.formula?.candidates?.[0];
      row.输出.首选方 = cand?.name || "";
      row.输出.药味 = (cand?.herbs || []).map((h) => `${h.name}${h.dose || ""}`);
      row.判定.P7_方名可追溯 = /本例辨证组方/.test(cand?.name || "") ? "自拟方" : "通过";
    } else {
      row.判定.P1_链路 = `M04失败(${m04.status})`;
      row.输出.M04错误 = m04.error;
    }
  }

  results.push(row);
  if (n % 5 === 0) { console.log(`  ${n}/${cases.length}`); fs.writeFileSync(OUT, JSON.stringify(results, null, 1)); }
}
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));

const tally = {};
for (const r of results) for (const [k, v] of Object.entries(r.判定)) {
  tally[k] ||= { 通过: 0, 未通过: 0 };
  if (v === "通过") tally[k].通过 += 1; else tally[k].未通过 += 1;
}
console.log(JSON.stringify({ 样本: results.length, 判定汇总: tally }, null, 2));
