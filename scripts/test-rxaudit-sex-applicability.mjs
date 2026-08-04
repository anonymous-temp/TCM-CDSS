// 审方风险的性别适用性裁剪（甲方生产实测 2026-08-04 缺陷2）。
//
// 生产实证（BASE_URL=https://82.156.128.153/tcm-cdss）：
//   · fixa-d2c（71 岁男性，胸痹血瘀）：中成药「丹参保心茶」说明书注意事项第 5 条
//     「儿童、孕妇、哺乳期妇女、经期妇女、年老体弱者应在医师指导下服用。」在医生正文里
//     **整条消失**（第 4 条后直接跳到第 6 条）——而对 71 岁患者成立的正是「年老体弱者」那一半。
//   · fixa-d2（58 岁男性，长期服阿司匹林）：逐味生成前安全边界
//     「丹参（出血倾向/月经期/抗凝状态:MEDIUM）…」被清成 19 个连续分号——
//     系统识别正确的活血药出血风险被整段抹掉；同样文本落在表格单元格里就是「本例男性不适用」。
//
// 同一个根因：适用性判断此前只有一道**按整格/整句**的文本净化，而风险的适用人群写法几乎都是
// 析取枚举，其中只有一部分限定女性生理状态。本套件把不变量钉死：
//   A. 男性患者：枚举里与性别无关的部分必须原样保留；
//   B. 男性患者：裁剪后的正文不得再残留女性生理限定词（否则下游整格净化仍会连坐）；
//   C. 整条只限定女性生理状态时，显式标 not_applicable，不把原文留给下游猜；
//   D. 女性/未知性别一个字都不改；风险等级、审方结论、问题条数一律不变。
import assert from "node:assert/strict";

const { normalizeAuditOutcomeForPatient, buildLingxiRiskSection, sexScopedRiskText, riskIsMaternalScopedOnly } =
  await import("../src/lib/rxaudit.ts");

const failures = [];
const check = (name, fn) => {
  try { fn(); } catch (error) { failures.push({ name, message: String(error?.message || error).slice(0, 600) }); }
};

// 下游确定性净化层（diagnosis-safety.sanitizePatientApplicableText）的判据面。
// 本套件不引用该模块的私有常量，而是独立复述它的**表面形式**：裁剪后的正文只要还命中它，
// 整格就会被改写成「本例男性不适用」——所以这就是本层必须清干净的边界。
const DOWNSTREAM_FEMALE_ONLY_SURFACE = /(月经|经期|妊娠|孕产|孕妇|孕期|哺乳|备孕女性)/;

const issue = (overrides) => ({
  issueId: "issue-1",
  riskLevel: "MEDIUM",
  issueType: "SPECIAL_POPULATION",
  title: "特殊人群用药提示",
  description: "说明书列有特殊人群使用限制。",
  relatedItemNos: [1],
  evidence: [{ sourceType: "INSTRUCTION", sourceName: "说明书", quote: "说明书注意事项" }],
  suggestions: ["请医生复核。"],
  ...overrides,
});
const outcome = (issues) => ({
  ok: true,
  source: "lingxi",
  degraded: false,
  auditResult: "MANUAL_REVIEW",
  highestRiskLevel: "MEDIUM",
  needManualReview: true,
  issues,
  itemCount: 1,
});

// 生产原文（受治理来源，逐字取自 local-patent-medicine-index / tcm-knowledge 的 population 字段）
const PATENT_PRECAUTION = "儿童、孕妇、哺乳期妇女、经期妇女、年老体弱者应在医师指导下服用。";
const BLEEDING_POPULATION = "出血倾向/月经期/抗凝状态：停用、替换或由医生/药师复核。";

check("A 男性：中成药说明书枚举里的「儿童」「年老体弱者」必须保留（生产 fixa-d2c 整条消失）", () => {
  const scoped = sexScopedRiskText(PATENT_PRECAUTION, "MALE");
  assert.ok(scoped.includes("儿童"), `与性别无关的「儿童」被删除：${scoped}`);
  assert.ok(scoped.includes("年老体弱者应在医师指导下服用"), `本例成立的「年老体弱者」被删除：${scoped}`);
  assert.ok(!DOWNSTREAM_FEMALE_ONLY_SURFACE.test(scoped), `裁剪后仍残留女性生理限定词，下游会整格连坐：${scoped}`);
});

check("A 男性：活血药出血风险的「出血倾向」「抗凝状态」必须保留（生产 fixa-d2 清成分号）", () => {
  const scoped = sexScopedRiskText(BLEEDING_POPULATION, "MALE");
  assert.ok(scoped.includes("出血倾向"), `出血倾向被删除：${scoped}`);
  assert.ok(scoped.includes("抗凝状态"), `抗凝状态被删除：${scoped}`);
  assert.ok(scoped.includes("医生") && scoped.includes("药师"), `动作正文被截断：${scoped}`);
  assert.ok(!DOWNSTREAM_FEMALE_ONLY_SURFACE.test(scoped), `裁剪后仍残留女性生理限定词：${scoped}`);
});

check("B 男性：整张审方表格的每个单元格都不得再触发下游整格改写", () => {
  const section = buildLingxiRiskSection(outcome([
    issue({ description: `丹参保心茶 ${PATENT_PRECAUTION}`, suggestions: [BLEEDING_POPULATION] }),
    issue({ issueId: "issue-2", title: "活血药出血风险", description: "丹参、桃仁、红花联用抗血小板药可增加出血风险。", suggestions: [BLEEDING_POPULATION] }),
  ]), "男");
  for (const line of section.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    assert.ok(
      !DOWNSTREAM_FEMALE_ONLY_SURFACE.test(line),
      `表格行仍会被下游改写为「本例男性不适用」：${line}`,
    );
  }
  assert.ok(section.includes("出血倾向"), "出血风险的适用人群不得整体消失");
  assert.ok(section.includes("年老体弱者"), "与性别无关的复核动作不得整体消失");
});

check("C 整条只限定女性生理状态时显式标不适用，不留原文给下游整格改写", () => {
  const normalized = normalizeAuditOutcomeForPatient(outcome([
    issue({ title: "妊娠禁用", description: "孕妇禁用。", suggestions: ["孕妇、哺乳期妇女禁用。"] }),
  ]), "男");
  assert.equal(normalized.issues.length, 1, "条目不得被删除");
  assert.equal(normalized.issues[0].patientApplicability, "not_applicable");
  assert.ok(
    !DOWNSTREAM_FEMALE_ONLY_SURFACE.test(normalized.issues[0].suggestions.join("")),
    `不适用说明本身仍含女性生理限定词：${normalized.issues[0].suggestions.join("")}`,
  );
  assert.equal(normalized.highestRiskLevel, "MEDIUM", "风险等级不得因适用性标注而变化");
  assert.equal(normalized.auditResult, "MANUAL_REVIEW", "审方结论不得因适用性标注而变化");
  assert.ok(riskIsMaternalScopedOnly("孕妇、哺乳期妇女禁用。"));
  assert.equal(riskIsMaternalScopedOnly(PATENT_PRECAUTION), false, "含儿童/年老体弱的枚举不是纯女性限定");
});

check("D 女性与未知性别一字不改；风险等级与条数不变", () => {
  for (const sex of ["女", undefined, "", "未知"]) {
    const normalized = normalizeAuditOutcomeForPatient(outcome([
      issue({ description: `丹参保心茶 ${PATENT_PRECAUTION}`, suggestions: [BLEEDING_POPULATION] }),
    ]), sex);
    assert.equal(normalized.issues.length, 1);
    assert.ok(normalized.issues[0].description.includes("经期妇女"), `sex=${sex} 不得裁剪：${normalized.issues[0].description}`);
    assert.ok(normalized.issues[0].suggestions[0].includes("月经期"), `sex=${sex} 不得裁剪：${normalized.issues[0].suggestions[0]}`);
    assert.equal(normalized.highestRiskLevel, "MEDIUM");
  }
});

check("D 男性：非枚举的单句风险原样保留（裁剪只针对枚举项，不得截断正常动作）", () => {
  const plain = "请复查凝血功能并评估是否需要调整抗血小板方案。";
  assert.equal(sexScopedRiskText(plain, "MALE"), plain);
  // 单段且整段限定女性时，本函数不做删改（整条判定由 issue 层承担）。
  assert.equal(sexScopedRiskText("孕妇禁用", "MALE"), "孕妇禁用");
});

console.log(JSON.stringify({ cases: 6, failures: failures.length }));
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
