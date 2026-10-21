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
//
// 2026-10-21：医生页面按 ABC 字段与验收项精简（src/lib/clinician-page-view.ts），「需优先补充」不再上屏，
// buildTieredSuggestedChecks 与中成药空状态、剂量来源中文名三个展示函数随之删除，判据①的用例一并删掉。
// 判据②（每个导出都必须仍有引用点）保留：它正是发现这三个函数变成死代码的那条。

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const failures = [];
const check = (name, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
};

// 甲方实测那一例的形状：只有主诉，现病史/体征/年龄皆缺。
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
console.log(JSON.stringify({ suite: "suggested-check-tiering", checks: 1, failures: 0 }));
