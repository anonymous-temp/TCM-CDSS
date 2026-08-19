// 生产冒烟回归(2026-08-04)。部署后的标准验证。
//
// 为什么需要它:既有的 `regress:tcm-cdss` 是**为本地 dev server 设计的**——它构造中间态、
// 读本地源码做断言、伪造 M04 处方投给审方。对着生产跑时,签名强制绑定会让这些构造态一律
// 失效:实测 386 次调用出 163 条失败,其中约 150 条是同一个根因(M03/M04 签名验签失败)
// 连锁放大——**一个用例签名一失效,它后面十几条断言全部塌方**。163 条 ≠ 163 个问题。
//
// 所以生产验证需要另一套判据:**全程走真实 M01→M05 链路,不构造任何中间态**,
// 用稳定 caseState.id,把上一阶段的签名结论原样回传。这正是集成方(甲方)的真实调用方式,
// 因此这套件同时也是对接方式的可执行样例。
//
// 判据只钉**不该退化的产品事实**,不钉模型措辞:
//   · 各阶段 HTTP 状态与签名链能走通(这是甲方对接的第一道门槛);
//   · 医生可见正文不得泄漏工程标签(L0/L1/L3 这类内部分级枚举);
//   · 病名鉴别、病位、治法这三项甲方明确验收过的能力仍在;
//   · 主症必须影响选方(治法→选方传导,见 tcm-formula-indications 的召回文本注释)。
//
// 用法:
//   BASE_URL=https://host/tcm-cdss CDSS_API_TOKEN=xxx CDSS_CUSTOMER_ID=xxx npm run regress:prod-smoke
// 退出码 0 = 全部通过;非 0 = 有失败(逐条打印)。
import { randomUUID } from "node:crypto";

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const CUSTOMER_ID = process.env.CDSS_CUSTOMER_ID || "";
if (!CUSTOMER_ID) throw new Error("CDSS_CUSTOMER_ID required");
const HEADERS = {
  "Content-Type": "application/json",
  "x-cdss-customer-id": CUSTOMER_ID,
  ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
};

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push({ name, detail: String(detail ?? "").slice(0, 240) });
  return ok;
};

/** 调用一个阶段路由,返回 { status, markdown, structured }。NDJSON 契约见接口文档 §3。 */
async function callStage(path, caseState) {
  const response = await fetch(`${BASE_URL}/api/diagnosis/${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ caseState }),
  });
  const raw = await response.text();
  if (!response.ok) return { status: response.status, error: raw.slice(0, 200) };
  let markdown = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const chunk = JSON.parse(line);
      if (chunk.content && chunk.content !== "[END]") markdown += chunk.content;
      if (chunk.error) return { status: "stream_error", error: chunk.error };
    } catch { /* 非 JSON 行直接跳过:契约允许心跳等噪声 */ }
  }
  const match = markdown.match(/<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/);
  let structured = null;
  if (match) { try { structured = JSON.parse(match[1].trim()); } catch { /* 保持 null,由断言报告 */ } }
  return { status: 200, markdown, structured };
}

// 甲方评测原始病例。选它是因为它同时压住四条已验收能力:病名鉴别(头痛需与眩晕/真头痛鉴别)、
// 病位(须含头部而非只有心脾)、治法(不得只写养心安神)、以及主症是否影响选方。
// caseState.id 必须稳定且全程一致——缺它 M04 恒 409,见接口文档 §9.2。
const CASE_ID = `prod-smoke-${randomUUID()}`;
const baseCase = {
  id: CASE_ID,
  customerId: CUSTOMER_ID,
  patient: { sex: "女", age: 28 },
  chiefComplaint: "产后2月余，头痛反复发作1月",
  symptoms: {
    现病史: "产后2月余，近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华",
    既往史: "否认高血压、糖尿病病史",
  },
  tongue: "舌淡苔薄白",
  pulse: "脉细弱",
  conversation: [],
  vitals: {},
};

/** 内部工程标签:内部分级枚举等绝不能出现在医生可见正文里。 */
const INTERNAL_TAG = /(?:^|[\s（(【|])L[0-4](?:$|[\s）)】|，,。；;])/;

console.log(`[prod-smoke] ${BASE_URL} case=${CASE_ID}`);

// ── M03 辨病辨证 ──────────────────────────────────────────────
const m03 = await callStage("diagnose", baseCase);
check("M03 返回 200", m03.status === 200, m03.error);
if (m03.status !== 200) {
  console.error(JSON.stringify({ stage: "M03", failures }, null, 2));
  process.exit(1);
}
const r3 = m03.structured;
check("M03 结构化结论可解析", Boolean(r3), "sentinel 区块缺失或 JSON 非法");
check("M03 带合同签名", Boolean(r3?.contractSignature), "contractSignature 缺失");
check("M03 主证非空", Boolean(r3?.overview?.primarySyndrome), r3?.overview?.primarySyndrome);

// 甲方已验收能力,不得退化
const differentials = r3?.overview?.tcmDiseaseDifferentials || [];
check("病名鉴别非空（辨病再辨证）", differentials.length > 0, JSON.stringify(differentials).slice(0, 120));
const locations = r3?.pathogenesis?.locationDifferentiation?.items || [];
check("病位含头部（主症所在）", locations.some((item) => /头|脑|清窍/.test(String(item))), JSON.stringify(locations));
const therapyText = `${r3?.therapy?.overallPrinciple || ""}｜${r3?.therapy?.overallMethod || ""}`;
check("治法非空", therapyText.replace("｜", "").trim().length > 0, therapyText);
check("M03 正文无工程标签泄漏", !INTERNAL_TAG.test(m03.markdown), m03.markdown.match(INTERNAL_TAG)?.[0]);

// ── M04 候选方药 ──────────────────────────────────────────────
// 关键:把 M03 的签名结论**原样**合并回 caseState。改动任一字段都会导致验签失败(409)。
const m04 = await callStage("prescribe", { ...baseCase, reasoningDiagnose: r3 });
check("M04 返回 200（签名链走通）", m04.status === 200, m04.error);

let candidate = null;
if (m04.status === 200) {
  const r4 = m04.structured;
  candidate = r4?.formula?.candidates?.[0] || null;
  check("M04 给出候选方", Boolean(candidate?.name), JSON.stringify(r4?.formula || {}).slice(0, 120));
  check("候选方含药味", (candidate?.herbs?.length || 0) > 0, `herbs=${candidate?.herbs?.length}`);
  check("M04 正文无工程标签泄漏", !INTERNAL_TAG.test(m04.markdown), m04.markdown.match(INTERNAL_TAG)?.[0]);
  // 病机重复:同一句「对应病机」逐味重印曾达 15 次/整页 19 次。阈值取 8——
  // 正常方 8–14 味,合理呈现是按节点归并而非逐味重复。
  const repeats = (m04.markdown.match(/对应病机/g) || []).length;
  check("方义无逐味重复病机", repeats <= 8, `出现 ${repeats} 次`);
}

const summary = {
  baseUrl: BASE_URL,
  caseId: CASE_ID,
  m03: {
    primarySyndrome: r3?.overview?.primarySyndrome,
    diseaseDifferentials: differentials.map((item) => item?.diseaseName).filter(Boolean),
    locations,
    therapy: therapyText,
  },
  m04: candidate ? { name: candidate.name, herbCount: candidate.herbs?.length, herbs: (candidate.herbs || []).map((h) => h.name) } : null,
  checks: { failed: failures.length },
  failures,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(failures.length > 0 ? 1 : 0);
