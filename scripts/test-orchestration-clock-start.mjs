/**
 * M03/M04 的编排时钟必须起在**临床事实准备之前**。
 *
 * 【钉的是什么】TCMEval-SDT 194 例实测：
 *   病例4  209.5s、病例148 202.0s —— 双双越过 M03 的 180s 编排时限，且两例复核都 unavailable。
 *
 * 根因不是时限失效，是**时钟起晚了**：
 * `callDiagnosisStream` 里 requestStartedAt 取 `opts.structuredOrchestrationStartedAt`，
 * 缺省则回落到 streamStartedAt。M04 路由在函数最顶部记下 orchestrationStartedAt 并传进去，
 * M03 路由**根本没传**——于是 180s 从 `maybeAttachClinicalFactsBackstop`（含 extract/review/
 * adjudicate 三次模型调用）跑完之后才开始计。总耗时变成「事实准备 + 180s」≈ 210s。
 *
 * M04 路由自己的注释早已写明这条的理由：「浏览器给整个请求 210s。把服务端 180s 的编排时钟
 * 起在临床事实/证据准备之前，这样流还能在浏览器余量内送出 fail-closed 兜底，
 * 而不是被切成 HTTP 0。」——同一处修复只做了一半，M03 漏了。
 *
 * 【为什么用源码级断言】时钟起点是路由层的一行赋值顺序，没有可导出的纯函数能表达
 * 「它在 await 之前」。这里断言的是**顺序关系**（赋值行早于 backstop 调用行），
 * 而不是「代码里有这一行」——顺序错了断言就红，这正是本缺陷的形状。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const ROUTES = [
  {
    label: "M03 diagnose",
    file: "src/app/api/diagnosis/diagnose/route.ts",
    stage: "diagnose",
  },
  {
    label: "M04 prescribe",
    file: "src/app/api/diagnosis/prescribe/route.ts",
    stage: "prescribe",
  },
];

for (const route of ROUTES) {
  const source = readFileSync(path.join(repoRoot, route.file), "utf8");

  const clockLine = source.split("\n").findIndex((line) => /const orchestrationStartedAt\s*=\s*Date\.now\(\)/.test(line));
  assert.ok(clockLine >= 0, `${route.label}：必须在路由里记录 orchestrationStartedAt`);

  // 只找**调用**行：必须排除 import 与注释——第一版被本文件自己解释缺陷的那段注释骗到，
  // 把注释行当成调用行，于是正向也红。判据要认的是代码，不是提到它的文字。
  const backstopLine = source.split("\n").findIndex((line) => {
    const trimmed = line.trim();
    if (!/maybeAttachClinicalFactsBackstop\s*\(/.test(trimmed)) return false;
    return !trimmed.startsWith("import") && !trimmed.startsWith("//") && !trimmed.startsWith("*");
  });
  assert.ok(backstopLine >= 0, `${route.label}：应存在临床事实回补调用（若已移除请同步本套件）`);

  assert.ok(
    clockLine < backstopLine,
    `${route.label}：编排时钟必须起在临床事实准备**之前**（实得 时钟行 ${clockLine + 1} / 回补行 ${backstopLine + 1}）。`
    + "起晚了，那几次模型调用不计入 180s 预算，总耗时变成「事实准备 + 180s」——"
    + "实测病例4 209.5s、病例148 202.0s 就是这么来的。",
  );

  assert.ok(
    /structuredOrchestrationStartedAt:\s*orchestrationStartedAt/.test(source),
    `${route.label}：记了时钟却不往下传等于没记——必须作为 structuredOrchestrationStartedAt 传给 callDiagnosisStream`,
  );
}

// 时限常量本身不得被悄悄放大来「解决」超时——那是把问题藏起来而不是修掉。
{
  const api = readFileSync(path.join(repoRoot, "src/lib/diagnosis-api.ts"), "utf8");
  const m03 = api.match(/M03_ORCHESTRATION_DEADLINE_MS[\s\S]{0,220}?\|\|\s*(\d[\d_]*)/);
  const m04 = api.match(/M04_ORCHESTRATION_DEADLINE_MS[\s\S]{0,220}?\|\|\s*(\d[\d_]*)/);
  assert.ok(m03 && m04, "应能读到两个编排时限的默认值");
  assert.equal(Number(m03[1].replace(/_/g, "")), 180_000, "M03 编排时限默认值应为 180s");
  assert.equal(Number(m04[1].replace(/_/g, "")), 120_000, "M04 编排时限默认值应为 120s");
  assert.match(api, /effectiveOrchestrationStartedAt\s*\+=\s*capacityWaitMs/,
    "共享容量队列等待时间必须从临床编排时钟中扣除");
  assert.match(api, /m03OrchestrationDeadlineExpired\(effectiveOrchestrationStartedAt,\s*Date\.now\(\)\)/,
    "M03 门禁必须使用扣除排队后的有效时钟");
  assert.match(api, /m04OrchestrationDeadlineExpired\(effectiveOrchestrationStartedAt,\s*Date\.now\(\)\)/,
    "M04 门禁必须使用扣除排队后的有效时钟");
}

console.log("test-orchestration-clock-start: OK", { routes: ROUTES.length });
