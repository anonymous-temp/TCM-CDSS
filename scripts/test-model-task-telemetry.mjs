/**
 * P0 全流水线模型调用账本。
 *
 * 钉住的缺陷（2026-08-29 token 审计）：`recordModelUsage` 只挂在 diagnosis-api 的 M03/M04 主链上，
 * 而 11 个模块各自直连 chat.completions.create，token 一分钱没记过——生产实测只能算出「调用次数
 * 上限」，算不出真实成本。本套件钉三件事：
 *   1. 账本本身的聚合语义（缓存命中率、尝试次数、问题码、首字时延）；
 *   2. observeModelTask 是透明包装（不改返回值、不吞异常、AbortError 归 aborted 档）；
 *   3. **源码级**：11 个自建调用点全部接上账本，且不落 PHI。第 3 条是防漂移的重点——
 *      新增一个直连调用点而不记账，本套件必须变红。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// 静态导入，不用 createJiti + 顶层 await import：两者混用会让整个套件体被执行两遍，
// 而账本的聚合存量是进程级全局（Symbol.for），第二遍会把第一遍的计数一起读进断言。
import {
  observeModelTask,
  recordModelTaskTelemetry,
  getCdssModelTaskTelemetrySnapshot,
  safeTaskKey,
} from "../src/lib/cdss-model-task-telemetry.ts";

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

// ── 1. 聚合语义 ────────────────────────────────────────────────────────────
recordModelTaskTelemetry({
  task: "unit_probe_a", stage: "diagnose", model: "qwen3.8-flash", outcome: "ok",
  durationMs: 1000, firstTokenMs: 400, promptTokens: 1000, completionTokens: 100,
  cachedTokens: 250, totalTokens: 1100, promptChars: 4000,
});
recordModelTaskTelemetry({
  task: "unit_probe_a", stage: "diagnose", model: "qwen3.8-flash", outcome: "ok",
  durationMs: 3000, firstTokenMs: 800, promptTokens: 1000, completionTokens: 300,
  cachedTokens: 250, totalTokens: 1300, promptChars: 4000, attempt: 2,
  issueCode: "m03_chain_empty",
});

const snap = () => getCdssModelTaskTelemetrySnapshot().tasks.unit_probe_a;

check("总数与结果分档", () => {
  assert.equal(snap().total, 2);
  assert.equal(snap().outcomes.ok, 2);
});
check("缓存命中率按 token 加权，不是按调用数平均", () => {
  // 500/2000 = 0.25。若实现改成「每次命中率的平均」，同样数据也是 0.25，
  // 所以另加一条不等权样本把两种算法分开。
  assert.equal(snap().cacheHitRatio, 0.25);
});
recordModelTaskTelemetry({
  task: "unit_probe_a", stage: "diagnose", model: "qwen3.8-flash", outcome: "ok",
  durationMs: 100, promptTokens: 8000, completionTokens: 10, cachedTokens: 0, totalTokens: 8010,
});
check("不等权样本证明是 token 加权：(500+0)/(2000+8000)=0.05", () => {
  assert.equal(snap().cacheHitRatio, 0.05);
});
check("尝试次数与重试计数", () => {
  assert.equal(snap().retried, 1, "attempt>1 的调用应计入 retried");
  assert.equal(snap().averageAttempts, Number(((1 + 2 + 1) / 3).toFixed(3)));
});
check("问题码进聚合（M04 长尾归因的钥匙）", () => {
  assert.equal(snap().issueCodes.m03_chain_empty, 1);
});
check("首字时延只统计有该字段的样本", () => {
  assert.equal(snap().firstTokenSampleSize, 2, "第三条无 firstTokenMs，不应被计入");
  assert.equal(snap().averageFirstTokenMs, 600);
});
check("模型身份进聚合", () => {
  assert.equal(snap().models["qwen3.8-flash"], 3);
});

// ── 2. 键的边界 ────────────────────────────────────────────────────────────
check("任务键词表化：脏字符被规整，不会撑爆键空间", () => {
  assert.equal(safeTaskKey("M03 西医半!!"), "m03______", "空格/中文/标点各折一个下划线");
  assert.equal(safeTaskKey(undefined), "unknown");
  assert.equal(safeTaskKey("qwen3.8-flash/repair"), "qwen3.8-flash/repair");
});

// ── 3. observeModelTask 是透明包装 ─────────────────────────────────────────
const okResult = await observeModelTask(
  { task: "unit_probe_b", model: "m" },
  async () => ({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
);
check("返回值原样透传", () => {
  assert.equal(okResult.choices[0].message.content, "x");
});
check("从返回体抽 usage", () => {
  const b = getCdssModelTaskTelemetrySnapshot().tasks.unit_probe_b;
  assert.equal(b.promptTokensTotal, 7);
  assert.equal(b.completionTokensTotal, 3);
});

await assert.rejects(
  () => observeModelTask({ task: "unit_probe_c", model: "m" }, async () => { throw new Error("boom"); }),
  /boom/,
  "异常必须原样抛出，不能被包装器吞掉",
);
check("失败调用记 error 档且不虚报 token", () => {
  const c = getCdssModelTaskTelemetrySnapshot().tasks.unit_probe_c;
  assert.equal(c.outcomes.error, 1);
  assert.equal(c.promptTokensTotal, 0);
});

const abortError = new Error("The operation was aborted");
abortError.name = "AbortError";
await assert.rejects(
  () => observeModelTask({ task: "unit_probe_d", model: "m" }, async () => { throw abortError; }),
  /aborted/,
);
check("中止与错误分开计——超时和真故障不是一回事", () => {
  const d = getCdssModelTaskTelemetrySnapshot().tasks.unit_probe_d;
  assert.equal(d.outcomes.aborted, 1);
  assert.equal(d.outcomes.error, 0);
});

// ── 4. 源码级：全部自建调用点都接上了账本 ──────────────────────────────────
const libDir = path.join(process.cwd(), "src/lib");
const files = fs.readdirSync(libDir).filter((name) => name.endsWith(".ts"));
const directCallers = files.filter((name) => {
  const body = fs.readFileSync(path.join(libDir, name), "utf8");
  return body.includes(".chat.completions.create(");
});
check("自建调用点数量与已知清单一致（新增一个未记账的调用点必须变红）", () => {
  assert.ok(directCallers.length >= 10, `期望 ≥10 个直连调用点，实际 ${directCallers.length}`);
});
for (const name of directCallers) {
  const body = fs.readFileSync(path.join(libDir, name), "utf8");
  // text-model.ts 是健康探针的通用出口，由调用方记账；其余全部必须自带账本。
  if (name === "text-model.ts") continue;
  check(`${name} 已接账本`, () => {
    assert.ok(
      body.includes("observeModelTask(") || body.includes("recordModelTaskTelemetry("),
      `${name} 直连了模型但没有接入 model_task 账本`,
    );
  });
}

// 裸 fetch 的独立复核端点也必须记账（它此前完全在账外）
const factsRuntime = fs.readFileSync(path.join(libDir, "clinical-facts-runtime.ts"), "utf8");
check("事实回补的 independent_review 裸 fetch 分支已记账", () => {
  // 终点必须从分支起点之后再找：getPrimaryTextModelConfig() 在本文件出现 4 次，
  // 裸 indexOf 会取到分支之前那处，切出空片段让断言静默空转（本仓已栽过的一类）。
  const branchStart = factsRuntime.indexOf('if (config.source === "independent_review") {');
  const branchEnd = factsRuntime.indexOf("const primary = getPrimaryTextModelConfig();", branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart, "定位锚点失效");
  const branch = factsRuntime.slice(branchStart, branchEnd);
  assert.ok(branch.length > 200, "分支切片越界，断言会空转");
  assert.ok(branch.includes("recordModelTaskTelemetry("), "裸 fetch 复核分支未记账");
});
check("事实三相位在账本里可分辨", () => {
  assert.ok(
    factsRuntime.includes("const task = `clinical_facts_${phase}`"),
    "三相位应各自成键，否则 extract/review/adjudicate 的成本混在一起看不出",
  );
});

// ── 5. 不落 PHI ────────────────────────────────────────────────────────────
const telemetrySource = fs.readFileSync(path.join(libDir, "cdss-model-task-telemetry.ts"), "utf8");
check("账本不接收也不落患者内容字段", () => {
  for (const forbidden of ["prompt:", "userPrompt", "content:", "caseState", "quote"]) {
    assert.ok(
      !telemetrySource.includes(forbidden),
      `账本源码出现疑似承载患者内容的字段 ${forbidden}`,
    );
  }
});
check("主链 firstTokenMs 从发起连接起算，含供应商排队", () => {
  const api = fs.readFileSync(path.join(libDir, "diagnosis-api.ts"), "utf8");
  assert.ok(api.includes("upstreamRequestStartedAt = Date.now();"), "缺少连接起点计时");
  assert.ok(
    api.includes("providerFirstContentMs = Date.now() - upstreamRequestStartedAt"),
    "首字时延必须相对连接起点，否则排队时间被排除在外，与解码时间分不开",
  );
});

console.log(JSON.stringify({ checks, directCallers: directCallers.length, failures: 0 }));
