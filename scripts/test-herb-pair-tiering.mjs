/**
 * 十八反 / 十九畏 的**分档**：硬门档与提示档各走各的出口。
 *
 * 【钉的是哪个缺陷】
 * 2026-08-13 鲁棒性专项实测：`findTcmHerbPairIncompatibilities` 对十九畏经典九对
 * **0/9 全不命中**。我第一版把它记成「治理表缺数据、需药师补录」——**记错了**。
 * 实测构建产物里十九畏 28 条齐全、别名已展开（丁香/母丁香、人参/红参、肉桂/官桂、
 * 巴豆/巴豆霜、硫黄/硫磺、芒硝/玄明粉/朴硝/牙硝、川乌/制川乌/草乌/制草乌/乌头），
 * 药名 100% 可解析。真因是 `highRiskPairRules()` 里一行 `severity !== "HIGH"` 的过滤，
 * 把整个类别对所有消费方隐藏了——丁香×郁金、人参×五灵脂、肉桂×赤石脂 这些门诊真会碰到的组合，
 * 审方、方前预检、页面展示三处一句提示都没有。
 *
 * 【为什么不是简单放开】
 * findTcmHerbPairIncompatibilities 同时喂着 diagnosis-stage-contract 的
 * candidate_N_high_risk_pair_incompatibility 驳回码。一把放开等于把十九畏变成整方作废的硬拦，
 * 与「安全问题阻断、质量问题标注」的既定准则相悖。十九畏传统上是「相畏」而非「相反」，
 * 源表给的正是 MEDIUM。所以硬门口径一字不动，另开 findTcmHerbPairCautions 给提示类出口。
 *
 * 【误报面已实测】受治理方剂 79216 张中含十九畏对 367 张（0.46%），
 * 只有十八反基线 1209 张（1.53%）的三分之一——不存在复核疲劳问题。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { findTcmHerbPairIncompatibilities, findTcmHerbPairCautions, buildTcmHerbPairAdvisory } =
  await jiti.import("../src/lib/tcm-knowledge.ts");

// ── 十九畏经典九对：提示档必须命中，硬门档必须**不**命中 ────────────────────
// 九对里 川乌×犀角、水银×砒霜、狼毒×密陀僧、牙硝×三棱、硫黄×朴硝 多为已淘汰的矿物/毒性药，
// 但仍应识别；丁香×郁金、人参×五灵脂、官桂×赤石脂、巴豆×牵牛 是门诊真会遇到的。
const NINETEEN_MUTUAL_FEARS = [
  ["硫黄", "朴硝"], ["水银", "砒霜"], ["狼毒", "密陀僧"], ["巴豆", "牵牛"],
  ["丁香", "郁金"], ["川乌", "犀角"], ["牙硝", "三棱"], ["官桂", "赤石脂"], ["人参", "五灵脂"],
];
for (const [left, right] of NINETEEN_MUTUAL_FEARS) {
  const cautions = findTcmHerbPairCautions([left, right, "茯苓", "甘草"]);
  assert.ok(cautions.length > 0, `十九畏应进提示档：${left}×${right}`);
  assert.ok(
    cautions.every((item) => item.severity !== "HIGH"),
    `十九畏不得标成 HIGH：${left}×${right}`,
  );
  assert.deepEqual(
    findTcmHerbPairIncompatibilities([left, right, "茯苓", "甘草"]), [],
    `十九畏不得进硬门档（那条路会产出整方作废的驳回码）：${left}×${right}`,
  );
}

// 别名/炮制品必须与原名同权（源表已展开，这里确认展开确实生效）
const ALIAS_PAIRS = [
  ["母丁香", "郁金"], ["红参", "五灵脂"], ["肉桂", "赤石脂"],
  ["巴豆霜", "牵牛子"], ["硫磺", "芒硝"], ["制川乌", "犀角"], ["水银", "信石"],
];
for (const [left, right] of ALIAS_PAIRS) {
  assert.ok(
    findTcmHerbPairCautions([left, right]).length > 0,
    `炮制品/别名写法应与原名同权命中提示档：${left}×${right}`,
  );
}

// ── 硬门档口径不得放宽：十八反仍走硬门，且不得掉进提示档 ────────────────────
const EIGHTEEN_CLASHES = [
  ["甘草", "甘遂"], ["甘草", "海藻"], ["半夏", "附子"], ["半夏", "制川乌"], ["党参", "藜芦"],
];
for (const [left, right] of EIGHTEEN_CLASHES) {
  const high = findTcmHerbPairIncompatibilities([left, right, "茯苓"]);
  assert.ok(high.length > 0, `十八反必须仍在硬门档：${left}×${right}`);
  assert.ok(high.every((item) => item.severity === "HIGH"), `十八反档位必须是 HIGH：${left}×${right}`);
}

// ── 阴性对照：常规方不得命中任何一档 ────────────────────────────────────────
const BENIGN = [
  ["北沙参", "麦冬", "玉竹", "生地黄", "石斛", "白芍", "甘草"],
  ["柴胡", "白芍", "白术", "茯苓", "当归", "陈皮", "炙甘草"],
  ["天麻", "钩藤", "石决明", "牛膝", "茯神", "甘草"],
];
for (const herbs of BENIGN) {
  assert.deepEqual(findTcmHerbPairIncompatibilities(herbs), [], `常规方不得命中硬门档：${herbs.join("、")}`);
  assert.deepEqual(findTcmHerbPairCautions(herbs), [], `常规方不得命中提示档：${herbs.join("、")}`);
}

// ── 方前预检提示：两档都要出现，且措辞可区分 ────────────────────────────────
{
  const advisory = buildTcmHerbPairAdvisory(["甘草", "甘遂", "丁香", "郁金", "茯苓"]);
  assert.ok(/甘草—甘遂/.test(advisory), "方前预检应报出十八反对");
  assert.ok(/丁香—郁金/.test(advisory), "方前预检应报出十九畏对");
  assert.ok(/强度低于十八反/.test(advisory), "十九畏措辞需标明强度低一档，否则医生无法区分处置优先级");
  assert.ok(!/阻断/.test(advisory.replace(/不阻断/g, "")), "两档都不得声称阻断流程");
}
{
  assert.equal(buildTcmHerbPairAdvisory(["北沙参", "麦冬", "甘草"]), "", "常规方不得产出方前预检提示");
}

console.log("test-herb-pair-tiering: OK", {
  nineteenFears: NINETEEN_MUTUAL_FEARS.length,
  aliasPairs: ALIAS_PAIRS.length,
  eighteenClashes: EIGHTEEN_CLASHES.length,
  benign: BENIGN.length,
});
