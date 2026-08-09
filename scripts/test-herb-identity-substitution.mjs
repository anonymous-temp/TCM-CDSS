/**
 * 身份核验专用的药味替代政策（党参/太子参 → 人参）。
 *
 * 为什么需要：目录记古方原文用药（497 首含人参），而现代临床普遍以党参代人参补气。
 * 实测 695 例——处方用党参 91 例(15.1%)、人参 44 例(7.3%)，模型写党参的频率是人参两倍，
 * 这是正确的现代做法。结果是香砂六君子汤、四君子汤、五福饮这类常用方因「缺人参」拿不到方名，
 * 医生看到「本例辨证组方」。缺人参的自拟例 41 条中 24 条处方里有党参(21)/太子参(3)。
 *
 * 本套件钉的**不是「多认出几个方名」，而是四条不许越过的线**：
 *   ① 替代只在身份核验生效，绝不进同药异名表（党参与人参是两味药，剂量/安全各归各）；
 *   ② 方名含「参」字者一律不适用（独参汤/参附汤 回阳固脱，党参无此力）；
 *   ③ 基准不含人参、或处方本就有人参时，不得产生任何改变；
 *   ④ 缺的是**方义承重药**时（二陈汤缺半夏）不得因替代而放行。
 */
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true, interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { verifyFormulaCompilationComponents } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const policy = JSON.parse(fs.readFileSync(
  path.join(repoRoot, "src/data/tcm-herb-identity-substitution-policy.source.json"), "utf8"));

let checks = 0;
const failures = [];
const ok = (label, condition) => { checks += 1; if (!condition) failures.push(label); };
const herbs = (...names) => names.map((name) => ({ name }));
const verified = (formula, list) => {
  const rows = verifyFormulaCompilationComponents([formula], list, false, true);
  return rows.length > 0 && rows.every((row) => row.verified);
};

// ── 政策表契约 ──────────────────────────────────────────────────────────────
ok("政策表有 schemaVersion", typeof policy.schemaVersion === "string");
ok("政策表有 sourceRefs", Array.isArray(policy.sourceRefs) && policy.sourceRefs.length > 0);
for (const entry of policy.entries) {
  ok(`${entry.prescribed} 声明作用域仅限身份核验`, entry.scope === "formula_identity_verification_only");
  ok(`${entry.prescribed} 有依据`, String(entry.basis || "").length > 15);
  ok(`${entry.prescribed} 有安全边界`, String(entry.notApplicableWhenFormulaNameContains || "").length > 0);
}

// ── ① 该救的救回来 ──────────────────────────────────────────────────────────
ok("四君子汤 接受党参", verified("四君子汤", herbs("党参", "白术", "茯苓", "炙甘草")));
ok("四君子汤 接受太子参", verified("四君子汤", herbs("太子参", "白术", "茯苓", "炙甘草")));
ok("香砂六君子汤 接受党参",
  verified("香砂六君子汤", herbs("党参", "白术", "茯苓", "姜半夏", "陈皮", "木香", "砂仁", "炙甘草")));
ok("四君子汤 原方仍通过", verified("四君子汤", herbs("人参", "白术", "茯苓", "炙甘草")));

// ── ② 回阳固脱方不得替代（方名含「参」）────────────────────────────────────
ok("参附汤 不接受党参", !verified("参附汤", herbs("党参", "附子")));
ok("独参汤 不接受党参", !verified("独参汤", herbs("党参")));

// ── ②' 机械规则的显式例外：逐方裁定，不接受整体放宽 ──────────────────────────
// 「方名含参字」会保守误挡补气类方。参苓白术散经甲方 2026-08-09 裁定放开——
// 它是补脾益气渗湿止泻方，不属回阳固脱，临床以党参代人参为常规。
// 两条断言必须同时成立：例外真的生效了，且例外**没有**顺带把回阳固脱方一起放开。
ok("参苓白术散 接受党参（甲方裁定的显式例外）",
  verified("参苓白术散", herbs("党参", "白术", "茯苓", "炒白扁豆", "陈皮", "山药", "炙甘草",
    "莲子", "砂仁", "薏苡仁", "桔梗")));
ok("例外未波及参附汤", !verified("参附汤", herbs("党参", "附子")));
for (const entry of policy.entries) {
  const allowlist = entry.applicableDespiteNameContains || [];
  ok(`${entry.prescribed} 的例外逐条带依据`,
    allowlist.length === 0 || String(entry.applicableDespiteNameContainsBasis || "").length > 20);
}

// ── ③ 无补气替代药时保持拒绝（这批是**正确拒绝**，实测 41 例缺人参中占 17 例）──
ok("清热利湿方不得被命名为四君子汤",
  !verified("四君子汤", herbs("黄柏", "薏苡仁", "忍冬藤", "赤芍", "川牛膝", "茯苓", "白术", "甘草")));

// ── ④ 方义承重药缺失不得因替代而放行 ────────────────────────────────────────
ok("缺半夏的方不得被命名为二陈汤",
  !verified("二陈汤", herbs("海藻", "浙贝母", "昆布", "陈皮", "茯苓", "甘草")));

// ── ⑤ 替代**只在身份核验**：不得混进同药异名表 ──────────────────────────────
// HARD_IDENTITY_HERB_ALIASES 是同药异名（黄耆=黄芪）。党参进去等于宣称它与人参是同一味药，
// 剂量边界与安全判定会一并被带偏。这条断言防的正是「下次有人图省事把它挪进那张表」。
const provenanceSource = fs.readFileSync(path.join(repoRoot, "src/lib/tcm-formula-provenance.ts"), "utf8");
const hardAliasBlock = provenanceSource.match(/const HARD_IDENTITY_HERB_ALIASES[^}]*\}/s)?.[0] || "";
for (const entry of policy.entries) {
  ok(`${entry.prescribed} 未混入同药异名表`, !hardAliasBlock.includes(entry.prescribed));
}

if (failures.length > 0) {
  console.error("[test:herb-identity-substitution] 失败项：");
  for (const item of failures) console.error("  - " + item);
}
assert.equal(failures.length, 0, `${failures.length}/${checks} 项失败`);
console.log(`[test:herb-identity-substitution] OK — ${checks} 项断言全过`);
