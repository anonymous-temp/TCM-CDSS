/**
 * 药名身份归一只能有一份来源——两处各写各的，其中一处漏了两个剂型后缀。
 *
 * 【实测缺陷（2026-08-17）】clinical-polarity 的 medicationEventIdentity 与
 * rxaudit 的 normalizedMedicationIdentity 是**同一个谓词写了两遍**：剥剂型后缀的循环
 * 一模一样，连 controlledAliases 映射表都逐字重复。差别只有一处：
 * **rxaudit 那份缺「混悬滴剂」「胶囊剂」。**
 *
 * 这不是「只是重复」——身份归一喂 verifyMedicationSemanticCoverage 的**同药状态冲突**判据，
 * 剥不掉后缀就被当成两个不同的药，冲突检测不到。方向是 fail-open：
 *   「现服阿莫西林胶囊，阿莫西林已停用」  → medication_status_conflict ✓（胶囊在表内）
 *   「现服布洛芬混悬滴剂，布洛芬已停用」  → **reason 为空，静默通过** ✗
 * 后者是真实的用药状态矛盾，本该转人工复核。**混悬滴剂正是儿科布洛芬/对乙酰氨基酚的标准剂型。**
 *
 * 【这条被判错过一次】2026-08-16 的缺陷形状扫描把它记为「属药名归一、非安全门控，影响低」
 * 而推迟。那个判断建立在读源码上。发布前补测推翻——写下来是为了记住：
 * 「两份表只差几个词」不能靠读代码判影响，要问这几个词喂给了谁。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { verifyMedicationSemanticCoverage } = await jiti.import("../src/lib/rxaudit.ts");
const { canonicalMedicationIdentity, MEDICATION_DOSAGE_FORM_SUFFIXES } =
  await jiti.import("../src/lib/clinical-polarity.ts");

const event = (drugName, status, quote) => ({
  drugName, status, doseText: null, frequency: null, administrationTiming: null,
  sourceQuotes: [quote], confidence: 0.9,
});
const conflictDetected = (current, stopped) => {
  const result = verifyMedicationSemanticCoverage(`现服${current}，${stopped}已停用`, {
    source: "model",
    events: [event(current, "current", `现服${current}`), event(stopped, "stopped", `${stopped}已停用`)],
    unresolvedReferences: [], needsManualReview: false, reason: "",
  });
  return (result.reason || "").includes("medication_status_conflict");
};

// ── 1. 受控剂型表里的**每一个**后缀都必须能让状态冲突检出 ──────────────────
// 逐个跑而不是抽查：分叉正是「表里有、某一处没有」，抽查会漏掉恰好没抽到的那个。
{
  assert.ok(
    MEDICATION_DOSAGE_FORM_SUFFIXES.length >= 20,
    `剂型后缀表应至少 20 项，实得 ${MEDICATION_DOSAGE_FORM_SUFFIXES.length}——表被缩减会让本套件空转`,
  );
  for (const suffix of MEDICATION_DOSAGE_FORM_SUFFIXES) {
    assert.ok(
      conflictDetected(`布洛芬${suffix}`, "布洛芬"),
      `剂型后缀「${suffix}」未被剥离，同药状态冲突漏检：`
      + `「现服布洛芬${suffix}，布洛芬已停用」应报 medication_status_conflict。`
      + "身份归一在 rxaudit 另抄一份短表时，这里就是漏检的样子。",
    );
  }
}

// ── 2. 阴性对照：确实是两个不同的药，不得误报冲突 ──────────────────────────
// 缺了这条，上面那组可以靠「一律报冲突」全绿。
{
  assert.equal(
    conflictDetected("阿莫西林", "布洛芬"), false,
    "两个确实不同的药不得报状态冲突——否则上一组断言可由「恒报」满足，是空转",
  );
  assert.equal(
    conflictDetected("阿莫西林胶囊", "布洛芬缓释片"), false,
    "剥掉剂型后仍是不同的药，不得报冲突",
  );
}

// ── 3. 受控别名同样只能有一份 ──────────────────────────────────────────────
{
  for (const [alias, canonical] of [["盐酸二甲双胍", "二甲双胍"], ["华法林钠", "华法林"],
    ["硫酸氢氯吡格雷", "氯吡格雷"], ["枸橼酸西地那非", "西地那非"]]) {
    assert.equal(
      canonicalMedicationIdentity(alias), canonical,
      `受控别名未落到规范名：「${alias}」应归一为「${canonical}」`,
    );
    assert.ok(
      conflictDetected(alias, canonical),
      `别名与规范名指同一个药，状态冲突必须检出：「现服${alias}，${canonical}已停用」`,
    );
  }
}

// ── 4. 源码级：剥离循环与两张表都不允许出现第二份 ──────────────────────────
// 行为断言证明「现在是对的」，这条防止有人再抄一份回去。
{
  const polarity = readFileSync(path.join(repoRoot, "src/lib/clinical-polarity.ts"), "utf8");
  const rxaudit = readFileSync(path.join(repoRoot, "src/lib/rxaudit.ts"), "utf8");
  assert.ok(
    /export const MEDICATION_DOSAGE_FORM_SUFFIXES/.test(polarity),
    "剂型后缀表必须是 clinical-polarity 的单一导出常量",
  );
  for (const [label, source] of [["clinical-polarity", polarity], ["rxaudit", rxaudit]]) {
    const inlineTables = (source.match(/const dosageForms\s*=/g) || []).length;
    assert.equal(
      inlineTables, 0,
      `${label} 不得再出现行内剂型表（实得 ${inlineTables} 处）——多一处就是又分叉了`,
    );
    const inlineAliases = (source.match(/const controlledAliases\s*[:=]/g) || []).length;
    assert.equal(
      inlineAliases, 0,
      `${label} 不得再出现行内受控别名表（实得 ${inlineAliases} 处）`,
    );
  }
  assert.ok(
    /canonicalMedicationIdentity/.test(rxaudit),
    "rxaudit 必须调用共享的 canonicalMedicationIdentity，而不是自己再实现一遍剥离循环",
  );
}

console.log("test-medication-identity-convergence: OK", {
  dosageFormSuffixes: MEDICATION_DOSAGE_FORM_SUFFIXES.length,
});
