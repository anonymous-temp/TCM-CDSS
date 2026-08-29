/**
 * P1 编排层 token/时延快赢包的防漂移套件。
 *
 * 钉住 2026-08-29 token 审计定位的六处编排浪费。每一条都对应一个可量化的生产事实，
 * 删掉或改回旧写法必须变红：
 *
 *  1. M03 证据块无总量上限（M04 已于 2026-08-25 加过同款预算，M03 一直裸拼到提示词硬上限）；
 *  2. M04 提示词里的 M03 载荷用 2 空格 pretty-print，体积多 30-40% 且每个修复轮重付；
 *  3. M02 出题提示把病历排在大段固定规范**之前**，与 M03 的缓存排序原则正好相反；
 *  4. 事实回补 7 个路由各自重抽，服务端无任何缓存/合流；
 *  5. M05 作文在 assess / post-prescription-risk / his-scheme 三个出口各付一次；
 *  6. 极性助手对同一份病历在 M03/M04 各发 2 次，共 4 次零复用；
 *  7. `preflightM03DiagnosticReview` 写好了但生产路径零调用。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { m03EvidencePromptBudgetChars, m04EvidencePromptBudgetChars } from "../src/lib/prompt-budget.ts";

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };
const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

// ── 1. M03 证据预算 ────────────────────────────────────────────────────────
check("M03 证据预算与 M04 同构且被钳制在合理区间", () => {
  assert.equal(m03EvidencePromptBudgetChars(), 15_000);
  assert.equal(m03EvidencePromptBudgetChars(), m04EvidencePromptBudgetChars());
});
check("M03 证据预算可由环境变量覆盖，越界值回落默认", () => {
  const original = process.env.PRIMARY_DIAGNOSE_EVIDENCE_MAX_CHARS;
  try {
    process.env.PRIMARY_DIAGNOSE_EVIDENCE_MAX_CHARS = "8000";
    assert.equal(m03EvidencePromptBudgetChars(), 8_000);
    process.env.PRIMARY_DIAGNOSE_EVIDENCE_MAX_CHARS = "999999";
    assert.equal(m03EvidencePromptBudgetChars(), 15_000, "越界值必须回落，不能放大提示词");
    process.env.PRIMARY_DIAGNOSE_EVIDENCE_MAX_CHARS = "10";
    assert.equal(m03EvidencePromptBudgetChars(), 15_000, "过小值同样回落，避免证据被裁到无用");
  } finally {
    if (original == null) delete process.env.PRIMARY_DIAGNOSE_EVIDENCE_MAX_CHARS;
    else process.env.PRIMARY_DIAGNOSE_EVIDENCE_MAX_CHARS = original;
  }
});
const diagnoseRoute = read("src/app/api/diagnosis/diagnose/route.ts");
check("diagnose 路由确实用上了预算而不是裸拼证据", () => {
  assert.ok(diagnoseRoute.includes("compactEvidenceContextForPrompt(evidenceContext, diagnoseEvidenceBudget)"),
    "M03 证据块必须经预算压缩后再拼进提示词");
  assert.ok(diagnoseRoute.includes("m03EvidencePromptBudgetChars()"));
});

// ── 2. M04 注入 M03 用 compact JSON ────────────────────────────────────────
const prompts = read("src/lib/diagnosis-prompts.ts");
check("M04 提示词里的 M03 载荷不再 pretty-print", () => {
  const start = prompts.indexOf("const structuredDiagnosis = diagnoseReasoning");
  assert.ok(start > 0, "锚点失效");
  const end = prompts.indexOf("\n  //", start + 50);
  assert.ok(end > start, "切片越界，断言会空转");
  const block = prompts.slice(start, end);
  assert.ok(block.includes("management: diagnoseReasoning.management || null,"), "切到的不是目标块");
  assert.ok(!block.includes("null, 2"), "M03 载荷仍在用 2 空格缩进序列化");
});

// ── 3. M02 提示块序：固定规范在前、病历在后 ───────────────────────────────
check("M02 出题提示把逐例病历放在固定规范之后（供应商前缀缓存要求）", () => {
  const start = prompts.indexOf("你是供接诊医生使用的中医CDSS高信息增益追问模块");
  assert.ok(start > 0, "M02 模板锚点失效");
  const end = prompts.indexOf("export type M03FormulaRetrievalOptions", start);
  assert.ok(end > start, "切片越界");
  const template = prompts.slice(start, end);
  const recordAt = template.indexOf("病历：${record}");
  const contractAt = template.indexOf("${compactJsonContract}");
  const rulesAt = template.indexOf("输出1到2题。");
  assert.ok(recordAt > 0 && contractAt > 0 && rulesAt > 0, "三个锚点都必须存在");
  assert.ok(rulesAt < recordAt, "固定出题规则必须排在逐例病历之前");
  assert.ok(contractAt < recordAt, "固定 JSON 合同必须排在逐例病历之前");
});
check("不可信数据边界说明仍排在患者数据之前", () => {
  const start = prompts.indexOf("你是供接诊医生使用的中医CDSS高信息增益追问模块");
  const end = prompts.indexOf("export type M03FormulaRetrievalOptions", start);
  const template = prompts.slice(start, end);
  assert.ok(
    template.indexOf("${UNTRUSTED_CLINICAL_DATA_INSTRUCTION}") < template.indexOf("病历：${record}"),
    "注入防御要求指令在前、不可信数据在后",
  );
});

// ── 4/5/6. 三处缓存与合流 ─────────────────────────────────────────────────
const factsRuntime = read("src/lib/clinical-facts-runtime.ts");
check("事实回补有服务端缓存 + 并发合流", () => {
  assert.ok(factsRuntime.includes("clinicalFactsServerCache"), "缺少服务端缓存");
  assert.ok(factsRuntime.includes("clinicalFactsInFlight"), "缺少并发合流");
});
check("事实缓存的过期判据复用 attestation 校验，不另写一套", () => {
  const start = factsRuntime.indexOf("function readClinicalFactsCache(");
  const end = factsRuntime.indexOf("function writeClinicalFactsCache(", start);
  assert.ok(start > 0 && end > start, "切片越界");
  const body = factsRuntime.slice(start, end);
  assert.ok(
    body.includes("hasValidClinicalFactsAttestation("),
    "命中判定必须走同一个 attestation 校验：另写一套过期规则就是同一判据两处各写各的",
  );
});
check("事实缓存只写成功结果（失败不得被钉死整个 TTL 窗口）", () => {
  const start = factsRuntime.indexOf("function writeClinicalFactsCache(");
  const end = factsRuntime.indexOf("export function resetClinicalFactsServerCache", start);
  assert.ok(start > 0 && end > start, "切片越界");
  const body = factsRuntime.slice(start, end);
  assert.ok(body.includes('facts.semanticStatus !== "checked"'), "必须挡住未通过复核的结果");
  assert.ok(body.includes("!facts?.attestation"), "必须挡住未签名的结果");
});
check("注入了自定义抽取函数时既不读也不写共享缓存", () => {
  assert.ok(
    factsRuntime.includes("const usesConfiguredModelPlan = llmCall === REAL_FACTS_LLM_CALL;"),
    "缓存键隐含「同一模型编排」前提，注入自定义抽取函数时该前提不成立",
  );
});

const m05 = read("src/lib/m05-followup-authoring.server.ts");
check("M05 作文有缓存 + 合流，且键取实际下发的用户消息", () => {
  assert.ok(m05.includes("authoredFollowupCache"), "缺少缓存");
  assert.ok(m05.includes("authoredFollowupInFlight"), "缺少并发合流");
  assert.ok(
    m05.includes("const cacheKey = authoredFollowupCacheKey(config.model, userContent);"),
    "键必须取实际提示词内容：clinicalContextForAuthoring 还会读 state，只按 input 建键会误判",
  );
});
check("M05 提示词只构建一次（缓存键与请求体共用同一份）", () => {
  const occurrences = m05.split("clinicalContextForAuthoring(").length - 1;
  // 一次定义 + 一次调用；若调用点又自己拼一遍就会变成 3 次。
  assert.ok(occurrences <= 2, `clinicalContextForAuthoring 被构建 ${occurrences} 次，应只有定义与单次调用`);
});

const polarity = read("src/lib/polarity-negation-assist.server.ts");
check("极性助手跨阶段复用（M03/M04 不再各发一轮）", () => {
  assert.ok(polarity.includes("polarityCache"), "缺少缓存");
  assert.ok(polarity.includes("polarityInFlight"), "缺少并发合流");
});
check("极性缓存键取送模型的脱敏正文，不是整个 CaseState", () => {
  const start = polarity.indexOf("function polarityCacheKey(");
  const end = polarity.indexOf("export function resetAssistedPolarityCache", start);
  assert.ok(start > 0 && end > start, "切片越界");
  const body = polarity.slice(start, end);
  assert.ok(body.includes("trustedInputText(sanitizeCaseStateForModel(caseState))"),
    "键必须与实际模型输入一致，否则 id/时间戳变化会造成无谓未命中");
});
check("极性全空结果不入缓存（那是降级值不是结论）", () => {
  assert.ok(
    polarity.includes("if (value.negated.size > 0 || value.affirmed.size > 0)"),
    "模型不可用时返回空集，缓存它会把瞬时不可用钉死成整窗不可用",
  );
});

// ── 7. preflight 接线 ─────────────────────────────────────────────────────
const api = read("src/lib/diagnosis-api.ts");
check("确定性复核前置判据已接进生产路径", () => {
  assert.ok(
    api.includes("const deterministicPreflight = preflightM03DiagnosticReview(reasoning, clinicalContext);"),
    "preflightM03DiagnosticReview 必须在模型复核之前跑",
  );
  const preflightAt = api.indexOf("const deterministicPreflight = preflightM03DiagnosticReview");
  const firstReviewAt = api.indexOf("const first = await runIndependentClinicalReview<M03DiagnosticReview>", preflightAt - 4000);
  assert.ok(preflightAt > 0 && firstReviewAt > preflightAt, "预检必须排在首轮模型复核之前才省得下调用");
});
check("预检短路只可能产出 repair，永不构成「已独立复核」的签名声明", () => {
  const start = api.indexOf("const deterministicPreflight = preflightM03DiagnosticReview");
  const end = api.indexOf("const first = await runIndependentClinicalReview<M03DiagnosticReview>", start);
  assert.ok(start > 0 && end > start, "切片越界");
  const block = api.slice(start, end);
  assert.ok(block.includes('reason: "repair"'), "短路结果必须标记为 repair");
  assert.ok(!block.includes('status: "accepted"'), "预检绝不能直接判通过");
  // 全局不变量：attestation 只在非 repair 时构造，所以预检的 repair verdict 进不了签名载荷。
  // 逐个构造点检查，而不是在切片上做否定前瞻——后者读不懂也验不准。
  const attestationCalls = [...api.matchAll(/clinicalReviewAttestation\(review, /g)];
  assert.ok(attestationCalls.length >= 6, `attestation 构造点只找到 ${attestationCalls.length} 个，锚点可能失效`);
  for (const match of attestationCalls) {
    const preceding = api.slice(Math.max(0, match.index - 160), match.index);
    assert.ok(
      preceding.includes('review.status === "repair"'),
      `attestation 构造点缺少 repair 短路（位置 ${match.index}）：repair verdict 一旦能签名，
       确定性预检就会变成「已独立复核」的虚假声明`,
    );
  }
});

// ── 8. 死代码已清除 ───────────────────────────────────────────────────────
check("已删除无调用方的 buildAssessPrompt（唯一把处方 Markdown 全文塞进提示词的构建器）", () => {
  assert.ok(!prompts.includes("buildAssessPrompt"), "死代码仍在");
});

console.log(JSON.stringify({ checks, failures: 0 }));
