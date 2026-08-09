/**
 * 方名与自身记录组成的名实一致性裁定：源表契约 + 构建产物落地。
 *
 * 为什么需要：目录里存在名实不符的条目，而命名层会以「完整包含」让这类小条目压过它所属的
 * 更大真方。线上实测（prod-smoke，2026-08-09）：一张归脾汤组成的处方被命名为
 * 「理气化痰汤加减」，治法却写「益气养血，和络止痛」——方名、组成、治法三者互相矛盾。
 * 根因是目录里 理气化痰汤《惠直堂经验方》记的组成是 人参黄芪当归身白芍茯苓白术炙甘草（纯补益），
 * 被处方完整包含，而真正的归脾汤缺远志/龙眼肉共 2 味、超过减味兜底层「最多缺 1 味」上限，
 * 正确方名结构上够不着。
 *
 * 裁定口径（重要，改动前先读）：入选的是「≤8 味且是更大条目真子集」的 277 条，
 * 但**遮蔽本身不是缺陷**——四君子汤 4 味遮蔽 57 张大方是正常的，它本来就是许多方的底子。
 * 裁的是这一条记录的组成与该方名在文献中的通行组成是否一致。
 *
 * fail-closed 的方向在这里是**反的**：这张表的作用是「取消资格」，所以宁可少收不可多收——
 * 错误地取消一条正当条目，等于凭空少给医生一个方名。因此只有 verdict=mismatched 且
 * confidence=high 才取消资格，unknown/low 一律只当人工复核待办。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));

const source = readJson("src/data/tcm-formula-name-composition-adjudications.source.json");
const catalog = readJson("src/data/tcm-formula-governed-catalog.json");

let checks = 0;
const failures = [];
const ok = (label, condition) => { checks += 1; if (!condition) failures.push(label); };

// ── 源表契约 ────────────────────────────────────────────────────────────────
ok("源表有 schemaVersion", typeof source.schemaVersion === "string" && source.schemaVersion.length > 0);
ok("源表有 sourceRefs", Array.isArray(source.sourceRefs) && source.sourceRefs.length > 0);
ok("源表条目非空", Array.isArray(source.entries) && source.entries.length > 0);

const VERDICTS = new Set(["consistent", "unknown", "mismatched"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const seen = new Set();
for (const entry of source.entries) {
  const key = `${entry.formulaName}@${entry.source}`;
  if (seen.has(key)) failures.push(`源表重复行: ${key}`);
  seen.add(key);
  if (!VERDICTS.has(entry.verdict)) failures.push(`未知 verdict: ${key} = ${entry.verdict}`);
  if (!CONFIDENCES.has(entry.confidence)) failures.push(`未知 confidence: ${key} = ${entry.confidence}`);
  if (!String(entry.reason || "").trim()) failures.push(`缺理由: ${key}`);
  if (!Array.isArray(entry.recordedIngredients) || entry.recordedIngredients.length === 0) {
    failures.push(`缺记录组成: ${key}`);
  }
}
checks += 4;

// ── 剔除集合必须恰好等于「mismatched + high」，一条都不能多、不能少 ──────────────
// 甲方 2026-08-09 决策：名实不符的条目**整条剔除**（连文献证据资格一并去掉），
// 不是此前的「只取消身份资格、保留为证据」。
const shouldDrop = new Set(
  source.entries
    .filter((e) => e.verdict === "mismatched" && e.confidence === "high")
    .map((e) => `${e.formulaName}@${e.source}`),
);
const actuallyDropped = new Set(catalog.summary?.nameCompositionMismatchDropped || []);
ok(
  `剔除集合与裁定一致（应 ${shouldDrop.size} 条，实 ${actuallyDropped.size} 条）`,
  shouldDrop.size === actuallyDropped.size && [...shouldDrop].every((key) => actuallyDropped.has(key)),
);

// 被剔除的条目必须真的不在目录里了。
for (const key of shouldDrop) {
  const [name] = key.split("@");
  ok(`${name} 已从目录中剔除`, !catalog.entries.some((e) => e.name === name));
}

// unknown / 非 high 的 mismatched **不得**被剔除——这是本表的反向护栏。
// 误剔一条正当条目等于凭空少给医生一个方名，代价高于留着一个错名。
for (const entry of source.entries) {
  if (entry.verdict === "mismatched" && entry.confidence === "high") continue;
  const key = `${entry.formulaName}@${entry.source}`;
  if (actuallyDropped.has(key)) {
    failures.push(`不该剔除却被剔除: ${key} (verdict=${entry.verdict}, confidence=${entry.confidence})`);
  }
  // 且必须仍然实际存在于目录里。
  if (!catalog.entries.some((e) => e.name === entry.formulaName && e.source === entry.source)) {
    failures.push(`裁定为 ${entry.verdict} 却不在目录里: ${key}`);
  }
}
checks += 2;

// ── 钉住那个触发本表的具体缺陷，防回归 ────────────────────────────────────────
ok(
  "理气化痰汤已整条剔除（名实不符：方名理气化痰，组成为纯补益）",
  !catalog.entries.some((e) => e.name === "理气化痰汤"),
);

// 正当的小方不得被误伤：四君子汤遮蔽 57 张大方，但它名实相符，必须保留资格。
const zhengdang = catalog.entries.find((e) => e.name === "四君子汤");
if (zhengdang) {
  ok("四君子汤保留命名资格（遮蔽不是缺陷）", zhengdang.identityLockEligible === true);
}

if (failures.length > 0) {
  console.error("[test:formula-name-composition-adjudication] 失败项：");
  for (const item of failures) console.error("  - " + item);
}
assert.equal(failures.length, 0, `${failures.length}/${checks} 项失败`);
console.log(
  `[test:formula-name-composition-adjudication] OK — ${checks} 项断言全过；` +
  `裁定 ${source.entries.length} 条（一致 ${source.summary?.consistent ?? "?"} / ` +
  `待复核 ${source.summary?.unknown ?? "?"} / 名实不符 ${source.summary?.mismatched ?? "?"}），` +
  `实际剔除 ${actuallyDropped.size} 条`,
);
