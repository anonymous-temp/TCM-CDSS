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
const FIRST_CONTENT_SLO_MS = Number(process.env.PROD_SMOKE_FIRST_CONTENT_SLO_MS || 5_000);
const M03_COMPLETION_SLO_MS = Number(process.env.PROD_SMOKE_M03_COMPLETION_SLO_MS || 60_000);
const M04_COMPLETION_SLO_MS = Number(process.env.PROD_SMOKE_M04_COMPLETION_SLO_MS || 90_000);
const PROD_SMOKE_SAMPLES = Math.max(1, Math.min(20, Number.parseInt(process.env.PROD_SMOKE_SAMPLES || "5", 10) || 5));

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push({ name, detail: String(detail ?? "").slice(0, 240) });
  return ok;
};

/** 调用一个阶段路由,返回 { status, markdown, structured }。NDJSON 契约见接口文档 §3。 */
async function callStage(path, caseState) {
  const startedAt = Date.now();
  const response = await fetch(`${BASE_URL}/api/diagnosis/${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ caseState }),
  });
  const responseHeaderMs = Date.now() - startedAt;
  let raw = "";
  let firstContentMs = null;
  let modelFirstContentMs = null;
  let pending = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      raw += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        try {
          const chunk = JSON.parse(line);
          if (firstContentMs == null && typeof chunk.content === "string" && chunk.content && chunk.content !== "[END]") {
            firstContentMs = Date.now() - startedAt;
          }
          if (modelFirstContentMs == null && chunk.type === "heartbeat" &&
              chunk.status === "模型已开始返回临床正文" && Number(chunk.processedChars) > 0) {
            modelFirstContentMs = Date.now() - startedAt;
          }
        } catch { /* 等待完整 NDJSON 行 */ }
      }
    }
    raw += decoder.decode();
  } else {
    raw = await response.text();
  }
  const durationMs = Date.now() - startedAt;
  if (!response.ok) return { status: response.status, error: raw.slice(0, 200), responseHeaderMs, firstContentMs, modelFirstContentMs, durationMs };
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
  return { status: 200, markdown, structured, responseHeaderMs, firstContentMs, modelFirstContentMs, durationMs };
}

/** 内部工程标签:内部分级枚举等绝不能出现在医生可见正文里。 */
const INTERNAL_TAG = /(?:^|[\s（(【|])L[0-4](?:$|[\s）)】|，,。；;])/;

function percentile95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

// 甲方评测原始病例。每个样本使用独立、稳定贯穿 M03→M04 的 caseState.id，既测真实签名链，
// 也让完成时延的 P95 来自多次完整临床编排，而不是单次请求或健康探针。
const samples = [];
let signedM03Count = 0;
let signedM03WithNonEmptyPrescription = 0;
for (let sampleIndex = 0; sampleIndex < PROD_SMOKE_SAMPLES; sampleIndex += 1) {
  const caseId = `prod-smoke-${randomUUID()}`;
  const label = `样本${sampleIndex + 1}`;
  const baseCase = {
    id: caseId,
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
  console.log(`[prod-smoke] ${BASE_URL} sample=${sampleIndex + 1}/${PROD_SMOKE_SAMPLES} case=${caseId}`);

  const m03 = await callStage("diagnose", baseCase);
  check(`${label} M03 返回 200`, m03.status === 200, m03.error);
  if (m03.status !== 200) {
    samples.push({ caseId, m03: { status: m03.status, timing: m03 } });
    continue;
  }
  const r3 = m03.structured;
  check(`${label} M03 结构化结论可解析`, Boolean(r3), "sentinel 区块缺失或 JSON 非法");
  check(`${label} M03 带合同签名`, Boolean(r3?.contractSignature), "contractSignature 缺失");
  check(`${label} M03 主证非空`, Boolean(r3?.overview?.primarySyndrome), r3?.overview?.primarySyndrome);
  check(`${label} M03 正文无工程标签泄漏`, !INTERNAL_TAG.test(m03.markdown), m03.markdown.match(INTERNAL_TAG)?.[0]);

  const differentials = r3?.overview?.tcmDiseaseDifferentials || [];
  const locations = r3?.pathogenesis?.locationDifferentiation?.items || [];
  const therapyText = `${r3?.therapy?.overallPrinciple || ""}｜${r3?.therapy?.overallMethod || ""}`;
  check(`${label} 病名鉴别非空（辨病再辨证）`, differentials.length > 0, JSON.stringify(differentials).slice(0, 120));
  check(`${label} 病位含头部（主症所在）`, locations.some((item) => /头|脑|清窍/.test(String(item))), JSON.stringify(locations));
  check(`${label} 治法非空`, therapyText.replace("｜", "").trim().length > 0, therapyText);
  if (r3?.contractSignature) signedM03Count += 1;

  const m04 = await callStage("prescribe", { ...baseCase, reasoningDiagnose: r3 });
  check(`${label} M04 返回 200（签名链走通）`, m04.status === 200, m04.error);
  let candidate = null;
  if (m04.status === 200) {
    const r4 = m04.structured;
    candidate = r4?.formula?.candidates?.[0] || null;
    const herbCount = candidate?.herbs?.length || 0;
    check(`${label} M04 给出候选方`, Boolean(candidate?.name), JSON.stringify(r4?.formula || {}).slice(0, 120));
    check(`${label} 候选方含药味`, herbCount > 0, `herbs=${herbCount}`);
    if (r3?.contractSignature && herbCount > 0) signedM03WithNonEmptyPrescription += 1;
    check(`${label} M04 正文无工程标签泄漏`, !INTERNAL_TAG.test(m04.markdown), m04.markdown.match(INTERNAL_TAG)?.[0]);
    const repeats = (m04.markdown.match(/对应病机/g) || []).length;
    check(`${label} 方义无逐味重复病机`, repeats <= 8, `出现 ${repeats} 次`);
  }
  samples.push({
    caseId,
    m03: {
      timing: {
        uiFirstContentMs: m03.firstContentMs,
        modelFirstContentMs: m03.modelFirstContentMs,
        durationMs: m03.durationMs,
      },
      primarySyndrome: r3?.overview?.primarySyndrome,
      diseaseDifferentials: differentials.map((item) => item?.diseaseName).filter(Boolean),
      locations,
      therapy: therapyText,
    },
    m04: candidate ? {
      timing: {
        uiFirstContentMs: m04.firstContentMs,
        modelFirstContentMs: m04.modelFirstContentMs,
        durationMs: m04.durationMs,
      },
      name: candidate.name,
      herbCount: candidate.herbs?.length,
      herbs: (candidate.herbs || []).map((herb) => herb.name),
    } : { timing: { modelFirstContentMs: m04.modelFirstContentMs, durationMs: m04.durationMs } },
  });
}

const m03ModelFirst = samples.flatMap((sample) => Number.isFinite(sample.m03?.timing?.modelFirstContentMs)
  ? [sample.m03.timing.modelFirstContentMs]
  : []);
const m03Durations = samples.flatMap((sample) => Number.isFinite(sample.m03?.timing?.durationMs)
  ? [sample.m03.timing.durationMs]
  : []);
const m04ModelFirst = samples.flatMap((sample) => Number.isFinite(sample.m04?.timing?.modelFirstContentMs)
  ? [sample.m04.timing.modelFirstContentMs]
  : []);
const m04Durations = samples.flatMap((sample) => Number.isFinite(sample.m04?.timing?.durationMs)
  ? [sample.m04.timing.durationMs]
  : []);
check("全部 M03 都上报真实模型首字", m03ModelFirst.length === PROD_SMOKE_SAMPLES,
  `observed=${m03ModelFirst.length}/${PROD_SMOKE_SAMPLES}`);
check("全部 M04 都上报真实模型首字", m04ModelFirst.length === PROD_SMOKE_SAMPLES,
  `observed=${m04ModelFirst.length}/${PROD_SMOKE_SAMPLES}`);
check("真实模型首字均 < 5s",
  [...m03ModelFirst, ...m04ModelFirst].length === PROD_SMOKE_SAMPLES * 2 &&
    [...m03ModelFirst, ...m04ModelFirst].every((value) => value < FIRST_CONTENT_SLO_MS),
  `max=${Math.max(0, ...m03ModelFirst, ...m04ModelFirst)}ms, budget=${FIRST_CONTENT_SLO_MS}ms`);
check("M03 完成 P95 < 60s", m03Durations.length === PROD_SMOKE_SAMPLES &&
  percentile95(m03Durations) < M03_COMPLETION_SLO_MS,
`p95=${percentile95(m03Durations)}ms, samples=${m03Durations.length}, budget=${M03_COMPLETION_SLO_MS}ms`);
check("M04 完成 P95 < 90s", m04Durations.length === PROD_SMOKE_SAMPLES &&
  percentile95(m04Durations) < M04_COMPLETION_SLO_MS,
`p95=${percentile95(m04Durations)}ms, samples=${m04Durations.length}, budget=${M04_COMPLETION_SLO_MS}ms`);
check("M03 已签名时处方非空率 = 100%", signedM03Count === PROD_SMOKE_SAMPLES &&
  signedM03WithNonEmptyPrescription === signedM03Count,
  `nonEmpty=${signedM03WithNonEmptyPrescription}/${signedM03Count}`);

const summary = {
  baseUrl: BASE_URL,
  sampleCount: PROD_SMOKE_SAMPLES,
  slo: {
    modelFirstContentMaxMs: Math.max(0, ...m03ModelFirst, ...m04ModelFirst),
    m03CompletionP95Ms: percentile95(m03Durations),
    m04CompletionP95Ms: percentile95(m04Durations),
    signedM03PrescriptionNonEmptyRate: signedM03Count
      ? signedM03WithNonEmptyPrescription / signedM03Count
      : 0,
  },
  samples,
  checks: { failed: failures.length },
  failures,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(failures.length > 0 ? 1 : 0);
