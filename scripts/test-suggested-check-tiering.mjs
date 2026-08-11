// 「需优先补充」的检查分级（2026-08-11 甲方线上实测第 11 条）。
//
// 实测：一例连现病史、生命体征都还没录的病例，「需优先补充」里把「头颅 CT」「经颅多普勒」
// 与「补充病程与诱因」并列写在同一行——把最贵的检查放进了第一步。
//
// 根因不是没写分级：buildTieredSuggestedChecks 早就实现了「先问诊查体、有指征再影像」，
// 但它的唯一调用点在 851e4d76（治法词表全量对账）里被连带删掉，从此是**死代码**——
// 于是线上渲染的是模型原样自由文本。本套件两条判据：
//   ① 分级行为本身（含红旗豁免、资料充分时不改写、不动点）；
//   ② result-display-policy 里每个导出都必须仍有调用点——这是"它怎么会没人发现"的那一层，
//      少了这条，下一次连带删除同样会静默通过全部门禁。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const policy = await import("../src/lib/result-display-policy.ts");
const { buildTieredSuggestedChecks, TIERED_FIRST_STEP_PREFIX } = policy;

const failures = [];
const check = (name, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
};

// 甲方实测那一例的形状：只有主诉，现病史/体征/年龄皆缺。
const sparseHeadache = { chiefComplaint: "头痛 3 天" };
const modelChecks = [
  "补充头痛病程、诱因与伴随症状",
  "头颅 CT 排除颅内器质性病变",
  "经颅多普勒评估脑血管",
  "血常规、C 反应蛋白",
];

check("资料稀疏时：影像降为『有指征再评估』，不与问诊查体并列", () => {
  const tiered = buildTieredSuggestedChecks(sparseHeadache, modelChecks);
  assert.ok(tiered[0].startsWith(TIERED_FIRST_STEP_PREFIX), `第一步应是问诊+查体，实际：${tiered[0]}`);
  assert.ok(tiered[0].includes("神经系统查体"), "头痛主诉的查体重点应落到神经系统");
  assert.ok(
    tiered.some((item) => /出现相应指征.*影像学检查/.test(item)),
    "影像应降级为条件句，而不是消失也不是并列",
  );
  for (const removed of ["头颅 CT", "经颅多普勒"]) {
    assert.ok(!tiered.some((item) => item.includes(removed)), `${removed} 不应仍以并列项出现`);
  }
  assert.ok(tiered.some((item) => item.includes("血常规")), "非影像类检查应原样保留，不得被一并抹掉");
});

check("红旗病例豁免：不得因为资料稀疏而延后检查", () => {
  const tiered = buildTieredSuggestedChecks(
    { ...sparseHeadache, safetyGate: { status: "red_flag" } },
    modelChecks,
  );
  assert.ok(tiered.some((item) => item.includes("头颅 CT")), "红旗病例的影像检查必须原样保留");
  assert.ok(!tiered[0].startsWith(TIERED_FIRST_STEP_PREFIX), "红旗病例不应被改写成先问诊");
});

check("资料充分时不改写模型判断", () => {
  const complete = {
    chiefComplaint: "头痛 3 天",
    patient: { age: 46, sex: "女" },
    vitals: { bp: "128/82", t: "36.6" },
    symptoms: { presentHistory: "3 天前无明显诱因出现右侧搏动性头痛，伴畏光，无发热无外伤。" },
  };
  const tiered = buildTieredSuggestedChecks(complete, modelChecks);
  assert.ok(tiered.some((item) => item.includes("头颅 CT")), "资料充分时不得下调模型给出的检查");
  assert.ok(!tiered[0].startsWith(TIERED_FIRST_STEP_PREFIX), "资料充分时不应插入补录首步");
});

check("不动点：分级结果再进一次原样返回", () => {
  const once = buildTieredSuggestedChecks(sparseHeadache, modelChecks);
  const twice = buildTieredSuggestedChecks(sparseHeadache, once);
  assert.deepEqual(twice, once, "重复分级把首步叠加了两遍");
});

// ── 「它怎么会没人发现」这一层 ────────────────────────────────────────────
// 展示策略是**只在渲染点生效**的一层：一旦调用点消失，产物立刻回落到模型自由文本，
// 而所有单元测试仍然全绿（函数本身还在，还能被直接 import 测）。所以判据必须落在
// 「有没有人调它」上，而不是「它算得对不对」上。
check("result-display-policy 的每个导出都仍有引用点", () => {
  const selfPath = fileURLToPath(new URL("../src/lib/result-display-policy.ts", import.meta.url));
  const source = readFileSync(selfPath, "utf8");
  const exported = [...source.matchAll(/^export (function|const|type) ([A-Za-z][A-Za-z0-9_]*)/gm)]
    // type 导出不产生运行时引用点，不在本判据范围内。
    .filter((match) => match[1] !== "type")
    .map((match) => ({ kind: match[1], name: match[2] }));
  assert.ok(exported.length >= 6, `导出数过少（${exported.length}），正则或文件结构已变`);

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(full);
    }
  };
  for (const root of ["src/app", "src/lib"]) walk(fileURLToPath(new URL(`../${root}`, import.meta.url)));

  // 把本文件自身的**声明行**剔掉再拼语料：模块内部的调用同样算引用（例如
  // hasMeaningfulMedicationRisk 只被同文件的 resolveAuditReviewPresentation 调用），
  // 但"它自己声明了自己"不能算。
  const corpus = files
    .map((file) => (file === selfPath
      ? source.split("\n").filter((line) => !/^export (?:function|const) /.test(line)).join("\n")
      : readFileSync(file, "utf8")))
    .join("\n");
  const orphans = exported
    // 函数要求真有调用；常量只要求被引用（它不会被"调用"）。
    .filter(({ kind, name }) => !new RegExp(`\\b${name}\\s*${kind === "function" ? "\\(" : ""}`).test(corpus))
    .map(({ name }) => name);
  assert.deepEqual(
    orphans,
    [],
    `展示策略成了死代码（导出但无人引用）：${orphans.join("、")}——` +
    "线上会直接回落到模型自由文本，且不会有任何测试变红",
  );
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "suggested-check-tiering", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "suggested-check-tiering", checks: 5, failures: 0 }));
