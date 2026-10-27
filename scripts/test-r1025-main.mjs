// 10/21 第十三轮（用户：线上按 ABC 字段 + 评测方案精简页面、后台接口不动；同样的输入两次结果要一样；模型搭配评估）。
//
//   1 医生页面的随访只取 M05「随访管理方案」「转诊评估」「红旗预警」三节（验收「随访建议」）；处方安全总评、整体状态复评表、
//     生活管理（与调护重复）、康复管理不取；随访方案里的「注意事项」与调护区重复，也不取。
//   2 结果复用指纹不含会话元数据：页面每新建一次病例，hisRecord 都带新的 caseId 和 updatedAt（未给时取当前时间），
//     同一份病历从页面录两次指纹从来对不上，页面用户一次也复用不到。病历内容照旧全量进指纹。
//   3 M05 随访撰写温度 0（此前 0.2，没有记录理由，是全链路唯一非 0 的首轮温度）。
//   4 事实抽取与用药规划按模型家族解析端点：CLINICAL_FACTS_MODEL / MEDICINE_PLANNER_MODEL 换成另一家族的模型时，
//     请求发到那一家的端点，而不是把 deepseek 模型名发到百炼端点。缺省（不设）时与此前完全相同。
//   2b 追问（M02）也纳入同一套复用：同一份病历同一道题；上游故障时的服务端兜底题不存。
//   5 页面源码：随访走 followupPlanItems；库存标签、经典条文面板、充分度卡、质量批注、病例分级徽标不再挂载；出处只列书名。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

// 端点解析读环境变量：先把两个家族都配齐（假密钥，不发请求）。
Object.assign(process.env, {
  AI_TEXT_PROVIDER: "bailian-qwen",
  BAILIAN_QWEN_API_KEY: "test-qwen-key",
  BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  BAILIAN_QWEN_MODEL: "qwen3.8-flash",
  OPENAI_API_KEY: "test-deepseek-key",
  OPENAI_BASE_URL: "https://api.deepseek.com/v1",
  OPENAI_MODEL: "deepseek-flash",
});
delete process.env.CLINICAL_FACTS_MODEL;
delete process.env.MEDICINE_PLANNER_MODEL;

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  await run();
  console.log(`  ok ${name}`);
};

const pageView = await jiti.import("../src/lib/clinician-page-view.ts");
const coalescing = await jiti.import("../src/lib/stage-result-coalescing.server.ts");
const factsRuntime = await jiti.import("../src/lib/clinical-facts-runtime.ts");
const planner = await jiti.import("../src/lib/medicine-candidate-planner.server.ts");

console.log("1 页面随访内容");
const m05 = [
  "## 处方安全总评",
  "**最高提示强度**：一般提示",
  "**综合风险判断**：中等风险，需医生核对后使用",
  "## 随访管理方案",
  "**首次复诊时间**：请在服完7剂药后（约7天后）复诊。",
  "**复诊评估重点**：胃脘胀痛是否减轻。",
  "**注意事项**：汤药宜温服。",
  "**无效或加重的处置预案**：如出现呕血、黑便，请立即到急诊就医。",
  "### 整体状态评估（按本例证候选取）",
  "| 维度 | 评估问题 |",
  "|---|---|",
  "| 睡眠 | 入睡快慢？ |",
  "服药期间请留意以上几方面的变化。",
  "## 生活管理",
  "饮食清淡易消化。",
  "## 转诊评估",
  "症状持续加重时及时转诊。",
  "## 红旗预警（患者须知）",
  "- 出现呼吸困难立即就医。",
].join("\n");
await check("1.1 取随访管理方案、转诊评估、红旗预警三节；带标签的拆成标签与内容，无标签的段落标签为空", async () => {
  assert.deepEqual(pageView.followupPlanItems(m05), [
    { label: "首次复诊时间", value: "请在服完7剂药后（约7天后）复诊。" },
    { label: "复诊评估重点", value: "胃脘胀痛是否减轻。" },
    { label: "无效或加重的处置预案", value: "如出现呕血、黑便，请立即到急诊就医。" },
    { label: "", value: "症状持续加重时及时转诊。" },
    { label: "", value: "出现呼吸困难立即就医。" },
  ]);
});
await check("1.2 不取：处方安全总评、整体状态复评（表格与表后说明）、生活管理、随访方案里的注意事项；空正文返回空数组", async () => {
  const values = pageView.followupPlanItems(m05).map((item) => item.value).join("|");
  for (const hidden of ["一般提示", "中等风险", "入睡快慢", "服药期间请留意以上几方面", "饮食清淡易消化", "汤药宜温服"]) {
    assert.ok(!values.includes(hidden), hidden);
  }
  assert.deepEqual(pageView.followupPlanItems(""), []);
  assert.deepEqual(pageView.followupPlanItems(undefined), []);
  assert.deepEqual(pageView.followupPlanItems("## 处方安全总评\n**最高提示强度**：一般提示"), []);
});

console.log("2 复用指纹");
const record = {
  chiefComplaint: "胃痛半月",
  patient: { sex: "男", age: 36 },
  symptoms: { 现病史: "胃脘胀痛，嗳气后缓解" },
  conversation: [],
  questionRounds: 0,
  maxQuestionRounds: 1,
  completeness: { level: "B" },
};
const tenant = { clientId: "c1", customerId: "hospital-b" };
const pageCase = (caseId, updatedAt, extra = {}) => ({
  ...record,
  id: caseId,
  hisRecord: {
    schemaVersion: "tcm-cdss-his-v1", source: "tcm-cdss-his", caseId, updatedAt, tongueImageUploaded: false,
    fields: { zhushu: "胃痛半月", xianbingshi: "胃脘胀痛，嗳气后缓解" }, rawText: "胃痛半月",
  },
  faceCapture: { summary: "面色萎黄", updatedAt },
  encounterScopeConfirmation: { sourceFingerprint: "fp-1", confirmedAt: updatedAt },
  ...extra,
});
await check("2.1 页面两次新建同一份病历（病例编号、更新时间、面诊与确认时间都不同）得到同一个指纹", async () => {
  const first = coalescing.stageRequestFingerprint("diagnose", tenant, pageCase("case-a", "2026-10-21T08:00:00.000Z"));
  const second = coalescing.stageRequestFingerprint("diagnose", tenant, pageCase("case-b", "2026-10-21T09:30:00.000Z"));
  assert.equal(first, second);
});
await check("2.2 对照：病历内容、面诊结果、确认对象任何一处不同，指纹就不同；租户不同也不同", async () => {
  const base = coalescing.stageRequestFingerprint("diagnose", tenant, pageCase("case-a", "t1"));
  const changedField = pageCase("case-a", "t1");
  changedField.hisRecord.fields.xianbingshi = "胃脘刺痛，夜间加重";
  assert.notEqual(coalescing.stageRequestFingerprint("diagnose", tenant, changedField), base);
  assert.notEqual(coalescing.stageRequestFingerprint("diagnose", tenant, pageCase("case-a", "t1", { faceCapture: { summary: "面色潮红", updatedAt: "t1" } })), base);
  assert.notEqual(coalescing.stageRequestFingerprint("diagnose", tenant, pageCase("case-a", "t1", { encounterScopeConfirmation: { sourceFingerprint: "fp-2", confirmedAt: "t1" } })), base);
  assert.notEqual(coalescing.stageRequestFingerprint("diagnose", { ...tenant, customerId: "hospital-a" }, pageCase("case-a", "t1")), base);
});

await check("2.3 追问阶段的指纹：诊断、处方等下游产物不影响出题；对话里的回答不同则不同", async () => {
  const base = pageCase("case-a", "t1", { phase: "question" });
  const key = coalescing.stageRequestFingerprint("question", tenant, base);
  const withDownstream = { ...base, phase: "done", diagnosis: "## 诊断", reasoningDiagnose: { stage: "diagnose" }, prescription: "## 处方" };
  assert.equal(coalescing.stageRequestFingerprint("question", tenant, withDownstream), key);
  const answered = { ...base, conversation: [{ role: "assistant", content: "怕冷还是怕热？" }, { role: "user", content: "怕冷" }] };
  assert.notEqual(coalescing.stageRequestFingerprint("question", tenant, answered), key);
  assert.notEqual(coalescing.stageRequestFingerprint("diagnose", tenant, base), key);
});
await check("2.4 追问结果复用：正常题第二次直接回放、不再计算；上游故障兜底题不存，下次照常重算", async () => {
  process.env.CDSS_STAGE_RESULT_REUSE = "true";
  delete process.env.CDSS_STAGE_RESULT_STORE_PATH;
  coalescing.resetStageResultCacheForTests();
  const ndjson = (content) => new Response(`${JSON.stringify({ content })}\n${JSON.stringify({ content: "[END]" })}\n`, { status: 200 });
  let computed = 0;
  const run = (key, content, degraded) => coalescing.coalesceStageResponse({
    stage: "question", key, compute: async () => { computed += 1; return ndjson(content); },
    cacheable: (final) => !degraded.has(final.trim()),
  }).then((response) => response.text());
  const model = '{"decision":"ask","questions":[{"id":"q1","question":"怕冷还是怕热？"}]}';
  await run("k-model", model, new Set());
  await run("k-model", model, new Set());
  assert.equal(computed, 1, "同一指纹第二次应回放");
  const fallback = '{"decision":"ask","questions":[{"id":"fb","question":"兜底题"}]}';
  await run("k-fallback", fallback, new Set([fallback]));
  await run("k-fallback", fallback, new Set([fallback]));
  assert.equal(computed, 3, "兜底题不入复用，第二次重算");
  coalescing.resetStageResultCacheForTests();
  delete process.env.CDSS_STAGE_RESULT_REUSE;
});
await check("2.5 追问路由接进复用：按追问阶段指纹、可显式重新生成、兜底正文不入复用；预取与不回答预计算在复用之外照常触发", async () => {
  const route = readFileSync("src/app/api/diagnosis/question/route.ts", "utf8");
  const post = route.slice(route.indexOf("async function handlePost"), route.indexOf("async function computeQuestion"));
  assert.match(post, /coalesceStageResponse\(\{\s*stage: "question",\s*key: stageRequestFingerprint\("question", parsed\.customer, parsed\.caseState\)/);
  assert.match(post, /bypass: regenerate/);
  assert.match(post, /cacheable: \(content\) => !degradedContents\.has\(content\.trim\(\)\)/);
  assert.ok(post.indexOf("precomputeNoAnswerPath(req, parsed.caseState)") < post.indexOf("coalesceStageResponse("));
  assert.ok(post.indexOf("prefetchDiagnoseInputs(parsed.caseState)") < post.indexOf("coalesceStageResponse("));
});

console.log("3 M05 撰写温度");
await check("3.1 M05 随访撰写请求温度 0", async () => {
  const source = readFileSync("src/lib/m05-followup-authoring.server.ts", "utf8");
  const call = source.slice(source.indexOf('task: "m05_followup_authoring"'), source.indexOf("messages:", source.indexOf('task: "m05_followup_authoring"')));
  assert.match(call, /temperature: 0,/);
  assert.doesNotMatch(call, /temperature: 0\.\d/);
});

console.log("4 按模型家族解析端点");
await check("4.1 事实抽取：缺省沿用主服务商（百炼 qwen）；CLINICAL_FACTS_MODEL=deepseek-flash 时发到 DeepSeek 端点", async () => {
  process.env.CLINICAL_FACTS_MODEL = "qwen3.8-max";
  const qwen = factsRuntime.getClinicalFactsModelPlan().extractor;
  assert.equal(qwen.model, "qwen3.8-max");
  assert.match(qwen.endpoint, /^https:\/\/dashscope\.aliyuncs\.com\//);
  assert.equal(qwen.configured, true);
  process.env.CLINICAL_FACTS_MODEL = "deepseek-flash";
  const deepseek = factsRuntime.getClinicalFactsModelPlan().extractor;
  assert.match(deepseek.endpoint, /^https:\/\/api\.deepseek\.com\//);
  assert.equal(deepseek.apiKey, "test-deepseek-key");
  assert.equal(deepseek.configured, true);
  delete process.env.CLINICAL_FACTS_MODEL;
  assert.match(factsRuntime.getClinicalFactsModelPlan().extractor.endpoint, /dashscope/);
});
await check("4.2 用药规划：不设 MEDICINE_PLANNER_MODEL 时沿用主服务商基础模型；设 deepseek-flash 时走 DeepSeek 端点", async () => {
  delete process.env.MEDICINE_PLANNER_MODEL;
  const base = planner.plannerModelConfig();
  assert.equal(base.model, "qwen3.8-flash");
  assert.match(base.baseUrl, /dashscope/);
  process.env.MEDICINE_PLANNER_MODEL = "deepseek-flash";
  const deepseek = planner.plannerModelConfig();
  assert.equal(deepseek.model, "deepseek-flash");
  assert.match(deepseek.baseUrl, /api\.deepseek\.com/);
  assert.equal(deepseek.configured, true);
  delete process.env.MEDICINE_PLANNER_MODEL;
});

console.log("5 页面挂载");
await check("5.1 随访走 followupPlanItems；库存标签、经典条文、充分度卡、质量批注、病例分级徽标不再挂载；出处只列书名", async () => {
  const page = readFileSync("src/app/diagnosis/DiagnosisClient.tsx", "utf8");
  assert.match(page, /followupPlanItems\(summary\.nonAuditAssessmentSection\)/);
  for (const gone of ["InventoryTagChip", "useInventoryTags", "ClassicEvidencePanel", 'data-testid="completeness-card"',
    'data-testid="server-quality-annotations"', 'data-testid="case-warning-level"', "buildSeasonalCare(", "symptomClusters"]) {
    assert.ok(!page.includes(gone), gone);
  }
  assert.match(page, /出处：\{formulaSourceForDisplay\(firstCandidate\.formulaSource\.source, firstCandidate\.name\)\}/);
});

console.log(`r1025 main: ${cases} checks passed`);
