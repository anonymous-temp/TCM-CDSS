/**
 * 药名身份归一只能有一份来源——两处各写各的，其中一处漏了两个剂型后缀。
 *
 * 【实测缺陷（2026-08-17）】clinical-polarity 的 medicationEventIdentity 与
 * rxaudit 的 normalizedMedicationIdentity 是**同一个谓词写了两遍**：剥剂型后缀的循环
 * 一模一样，连 controlledAliases 映射表都逐字重复。差别只有一处：
 * **rxaudit 那份缺「混悬滴剂」「胶囊剂」。**
 *
 * （2026-09-25 起该判据随灵犀审方一并删除，身份归一现在喂本地现用药范围判据，见文件末段。）
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
const { localMedicationScopeReason } = await jiti.import("../src/lib/local-prescription-checks.ts");
const { canonicalMedicationIdentity, MEDICATION_DOSAGE_FORM_SUFFIXES } =
  await jiti.import("../src/lib/clinical-polarity.ts");

// 2026-09-25 灵犀审方删除后，模型用药事件抽取随之删除，「同药状态冲突」判据不再存在；
// 身份归一如今喂的是本地现用药范围判据：原文只记了「本次/局部未用药」时，只有能证明的
// **具体**现用药才能免于「不能排除长期或其他现用药」的待核对提示。剥不掉剂型后缀或
// 认不出受控别名，具体药名就被当成身份不明，同样是分叉的样子（方向相反：多报而非漏报）。
const provenCurrent = (medicine) =>
  localMedicationScopeReason({ patient: {}, conversation: [], medicationHistory: `现服${medicine}，发病后未服其他药` }) === undefined;

// ── 1. 受控剂型表里的**每一个**后缀都必须能被剥离、认出同一具体药 ─────────────
// 逐个跑而不是抽查：分叉正是「表里有、某一处没有」，抽查会漏掉恰好没抽到的那个。
{
  assert.ok(
    MEDICATION_DOSAGE_FORM_SUFFIXES.length >= 20,
    `剂型后缀表应至少 20 项，实得 ${MEDICATION_DOSAGE_FORM_SUFFIXES.length}——表被缩减会让本套件空转`,
  );
  for (const suffix of MEDICATION_DOSAGE_FORM_SUFFIXES) {
    assert.ok(
      provenCurrent(`布洛芬${suffix}`),
      `剂型后缀「${suffix}」未被剥离：「现服布洛芬${suffix}」应认作具体现用药布洛芬。`
      + "身份归一另抄一份短表时，这里就是分叉的样子。",
    );
  }
}

// ── 2. 阴性对照：认不出的名字不得被当成具体药 ─────────────────────────────────
// 缺了这条，上面那组可以靠「一律认作具体药」全绿。
{
  for (const unknown of ["维生素片", "降压药片", "感冒药片", "抗生素胶囊"]) {
    assert.equal(provenCurrent(unknown), false, `「${unknown}」不是可证明的具体药名，不得免于待核对`);
  }
}

// ── 3. 受控别名同样只能有一份 ──────────────────────────────────────────────
{
  for (const [alias, canonical] of [["盐酸二甲双胍", "二甲双胍"], ["华法林钠", "华法林"],
    ["硫酸氢氯吡格雷", "氯吡格雷"], ["枸橼酸西地那非", "西地那非"]]) {
    assert.equal(
      canonicalMedicationIdentity(alias), canonical,
      `受控别名未落到规范名：「${alias}」应归一为「${canonical}」`,
    );
    assert.ok(provenCurrent(alias), `别名「${alias}」必须认作具体现用药「${canonical}」`);
  }
}

// ── 4. 源码级：剥离循环与两张表都不允许出现第二份 ──────────────────────────
// 行为断言证明「现在是对的」，这条防止有人再抄一份回去。
{
  const polarity = readFileSync(path.join(repoRoot, "src/lib/clinical-polarity.ts"), "utf8");
  const local = readFileSync(path.join(repoRoot, "src/lib/local-prescription-checks.ts"), "utf8");
  assert.ok(
    /export const MEDICATION_DOSAGE_FORM_SUFFIXES/.test(polarity),
    "剂型后缀表必须是 clinical-polarity 的单一导出常量",
  );
  for (const [label, source] of [["clinical-polarity", polarity], ["local-prescription-checks", local]]) {
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
    /canonicalMedicationIdentity/.test(local),
    "local-prescription-checks 必须调用共享的 canonicalMedicationIdentity，而不是自己再实现一遍剥离循环",
  );
}

console.log("test-medication-identity-convergence: OK", {
  dosageFormSuffixes: MEDICATION_DOSAGE_FORM_SUFFIXES.length,
});
