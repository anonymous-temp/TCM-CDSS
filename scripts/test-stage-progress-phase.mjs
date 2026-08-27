/**
 * 心跳阶段名必须与真实编排阶段一致（2026-08-27 实测缺陷）。
 *
 * M03/M04 的流消费器把服务端每 5s 的 `{type:"heartbeat",status}` 直接追加到医生可见的
 * 进度卡（diagnosis-engine.ts：`[visible, status].join("\n\n")`）。而阶段名此前只由
 * contentChars/reasoningChars 推断，这两个计数在**首稿流结束后就不再变**——于是独立复核
 * （5–15s）与逐轮定稿修订（每轮 40–50s）全程都在报「模型正在组织临床正文」。
 * M04 中位 43.6s 里有相当一段医生读到的是一句与实际不符的进度。
 *
 * 修法不是在心跳里补 if，而是把阶段名收成**单一权威**：一个 orchestrationPhase 变量，
 * 只由「进入复核」和「进入第 N 轮修订」这两个单一入口写。因此本套件既钉纯函数的输出，
 * 也钉 diagnosis-api.ts 的接线——后者才是真正会漂移的地方（本仓头号缺陷形状：
 * 同一判据两处各写各的）。
 *
 * 边界重申：这里只报**阶段名**，不下发第二份临床正文。M04 含药味剂量，必须整体校验通过
 * 才可见（见 diagnosis-stream-modules.ts 顶部关于 provisional representation 的既有决策）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STAGE_PROGRESS_PHASES,
  STAGE_PROGRESS_HEARTBEAT_SUFFIX,
  stageProgressHeartbeatStatus,
} from "../src/lib/diagnosis-stream-protocol.ts";

const base = { phase: "draft", structuredStage: "prescribe", contentChars: 0, reasoningChars: 0, repairRound: 0 };
const status = (patch) => stageProgressHeartbeatStatus({ ...base, ...patch });

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; console.log(`  ✓ ${label}`); };

// ── 1. 首稿阶段：三分支逐字保持原行为（这是既有可见文案，不该借机改口径）
check("首稿·仅推理内容 → 深度推理", () => {
  assert.equal(status({ reasoningChars: 800 }), `模型正在进行深度推理${STAGE_PROGRESS_HEARTBEAT_SUFFIX}`);
});
check("首稿·已有正文 → 组织临床正文", () => {
  assert.equal(status({ contentChars: 1200, reasoningChars: 800 }), `模型正在组织临床正文${STAGE_PROGRESS_HEARTBEAT_SUFFIX}`);
});
check("首稿·尚无任何返回 → 等待模型开始响应", () => {
  assert.equal(status({}), `正在等待模型开始响应${STAGE_PROGRESS_HEARTBEAT_SUFFIX}`);
});

// ── 2. 复核阶段：即便 contentChars 还停在首稿的值，也不得再报「正在组织临床正文」
check("复核·M04 报处方复核而非组织正文", () => {
  const text = status({ phase: "review", structuredStage: "prescribe", contentChars: 12_000 });
  assert.ok(text.includes("独立复核"), text);
  assert.ok(text.includes("处方"), text);
  assert.ok(!text.includes("正在组织临床正文"), `复核阶段仍在报首稿文案：${text}`);
});
check("复核·M03 报辨病辨证复核", () => {
  const text = status({ phase: "review", structuredStage: "diagnose", contentChars: 12_000 });
  assert.ok(text.includes("辨病辨证"), text);
  assert.ok(!text.includes("正在组织临床正文"), text);
});
check("复核·非结构化阶段有中性兜底，不落空串", () => {
  const text = status({ phase: "review", structuredStage: undefined, contentChars: 5 });
  assert.ok(text.includes("独立复核"), text);
});

// ── 3. 修订阶段：轮次要如实报出（医生据此区分「还在改」与「卡住了」）
check("修订·报出真实轮次", () => {
  assert.equal(status({ phase: "repair", repairRound: 2, contentChars: 9_000 }), `正在按复核意见第 2 轮修订定稿${STAGE_PROGRESS_HEARTBEAT_SUFFIX}`);
});
check("修订·轮次异常值不产出「第 0 轮」这类不可能文案", () => {
  for (const round of [0, -3, Number.NaN, undefined]) {
    const text = status({ phase: "repair", repairRound: round });
    assert.ok(text.includes("第 1 轮"), `round=${String(round)} → ${text}`);
  }
});

// ── 4. 全阶段共性：后缀统一、无空文案
check("每个阶段都产出带统一后缀的非空文案", () => {
  assert.ok(STAGE_PROGRESS_PHASES.length >= 3, `阶段集合被削减到 ${STAGE_PROGRESS_PHASES.length} 项`);
  for (const phase of STAGE_PROGRESS_PHASES) {
    const text = status({ phase, repairRound: 1 });
    assert.ok(text.trim().length > 0, `${phase} 产出空文案`);
    assert.ok(text.endsWith(STAGE_PROGRESS_HEARTBEAT_SUFFIX), `${phase} 后缀不一致：${text}`);
  }
});

// ── 5. 接线断言：阶段名必须只有单一权威，否则新增一处修复轮就会漏掉阶段名
const api = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");

check("修复轮计数只有一个写入点，且在 beginStructuredRepairRound 内", () => {
  const increments = api.match(/structuredRetryCount \+= 1;/g) || [];
  assert.equal(increments.length, 1, `修复轮计数散落成 ${increments.length} 处`);
  const helper = api.slice(api.indexOf("const beginStructuredRepairRound"));
  assert.ok(helper.length > 0, "未找到 beginStructuredRepairRound");
  const helperBody = helper.slice(0, helper.indexOf("};") + 2);
  assert.ok(helperBody.length < 400, `helper 边界切过头（${helperBody.length} 字符），断言会空转`);
  assert.ok(helperBody.includes("structuredRetryCount += 1;"), "计数不在 helper 内");
  assert.ok(helperBody.includes('orchestrationPhase = "repair"'), "helper 未置位修订阶段");
  assert.ok((api.match(/beginStructuredRepairRound\(\);/g) || []).length >= 4, "修复轮调用点少于已知的 4 处");
});

check("独立复核接的是 Promise，阶段名不会等到复核结束才置位", () => {
  assert.equal((api.match(/observeClinicalReview\(await /g) || []).length, 0,
    "存在 observeClinicalReview(await …)：阶段名只会在复核结束后才置位，那段等待照旧误报");
  // 定义处写作 `observeClinicalReview = async <T…>`，不匹配「函数名 + 左括号」，无需扣除。
  // `async () => observeClinicalReview(` 这类无 await 的转交形态同样算调用点，只统计 await 会漏掉它。
  const callSites = (api.match(/observeClinicalReview\(/g) || []).length;
  assert.ok(callSites >= 6, `复核观察点为 ${callSites} 处，少于已知的 6 处`);
});

check("阶段名写入点恰好两处，心跳文案不在 diagnosis-api.ts 内重复", () => {
  const writes = api.match(/orchestrationPhase = "/g) || [];
  assert.equal(writes.length, 2, `阶段名写入点为 ${writes.length} 处（应为复核 + 修订各一处）`);
  assert.ok(api.includes("stageProgressHeartbeatStatus({"), "心跳未接线到阶段名函数");
  assert.ok(!api.includes("模型正在组织临床正文"), "首稿文案在 diagnosis-api.ts 里被复写了一份，两处会分叉");
});

check("定稿正文下发即停表，进度行不会挂在已完成的报告下面", () => {
  const enqueueStart = api.indexOf("const enqueueClient = (content: string) => {");
  assert.ok(enqueueStart > 0, "未找到 enqueueClient");
  const body = api.slice(enqueueStart, enqueueStart + api.slice(enqueueStart).indexOf("};") + 2);
  assert.ok(body.length < 900, `enqueueClient 边界切过头（${body.length} 字符），断言会空转`);
  assert.ok(/content\.startsWith\(STREAM_REPLACE_MARKER\)\s*\)\s*stopHeartbeat\(\)/.test(body),
    "定稿正文下发时未停表：心跳仍会在完整报告下面追加一行「进行中」");
});

console.log(`\n心跳阶段名：${checks} 项断言全部通过`);
