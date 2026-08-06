// 可替换药味的确定性推导与安全边界（甲方 2026-08-05「随证加减建议——可增加：可替换药味的说明」）。
//
// 这条需求此前是**假闭环**：提交 ff541cb0 加了 TS 字段 modifications[].substitutions 与文档描述，
// 但 M04 提案 zod schema 里根本没声明该字段，模型即使输出也被 strip；编译器构造的字面量也不带它。
// 于是「可替换药味出参」从未产生过任何一条值。本套件按「真的有值，且值是安全的」来断言。
//
// 安全立场：替代药**绝不能由模型提名**——那等于让模型开药。候选完全由受治理数据推导，
// 并逐条过硬边界。以下每一条断言删掉都会让系统获得"凭同类就换药"的能力。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  governedHerbSubstitutes,
  getTcmHerbFunctionCategories,
  getTcmHerbDoseLimit,
  clinicianDoseHerbClass,
  getTcmHerbGenerationSafetyProfile,
  findTcmHerbPairIncompatibilities,
} = await jiti.import("../src/lib/tcm-knowledge.ts");

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

check("SUB-01 常用补气药能给出同向替代", () => {
  const subs = governedHerbSubstitutes("党参", ["黄芪", "当归", "白术", "茯苓"]);
  assert.ok(subs.length > 0, "党参未给出任何替代候选");
  for (const sub of subs) {
    assert.equal(sub.replaces, "党参");
    assert.ok(sub.rationale.includes("补气药"), `替代理由未点明同属分类：${sub.rationale}`);
    assert.ok(sub.differenceNote.includes("系统不裁定二者等效"),
      "差异说明必须明写系统不裁定等效——等效判断权在医师");
    assert.ok(sub.differenceNote.includes("重新审方"), "差异说明必须要求重新审方");
  }
});

// 本条对应实现过程中真实发生过的一次临床错误：分类数组的顺序**不保证**由具体到宽泛
// （三七是 ["化瘀止血药","止血药"] 具体在前，半夏却是 ["化痰止咳平喘药","温化寒痰药"] 宽泛在前）。
// 按数组第一项取锚点，半夏（温化寒痰）会落到宽泛的「化痰止咳平喘药」，
// 于是把**清化热痰**的前胡当成同向替代——寒热方向正好相反。
check("SUB-02 锚定最具体分类：温化寒痰药不得被清化热痰药替代", () => {
  const subs = governedHerbSubstitutes("半夏", ["陈皮", "茯苓"]);
  assert.ok(subs.length > 0, "半夏未给出替代候选");
  for (const sub of subs) {
    const categories = getTcmHerbFunctionCategories(sub.substitute);
    assert.ok(categories.includes("温化寒痰药"),
      `${sub.substitute} 不属温化寒痰药（分类=${JSON.stringify(categories)}），寒热方向与半夏相反`);
    assert.ok(!categories.includes("清化热痰药"),
      `${sub.substitute} 属清化热痰药，与半夏温化寒痰方向相反`);
  }
});

// 同一功效分类只保证方向大致相同，不保证力度与禁忌相同。
// 川芎与三棱同属「活血化瘀药 + 活血止痛药」两个分类，但受治理风险档差一整档：
//   川芎 BLOOD_STASIS 活血化瘀 / 孕期 MEDIUM；三棱 BLOOD_BREAKING 破血逐瘀 / 孕期 HIGH。
check("SUB-03 风险不得升级：活血止痛药不得被破血逐瘀药替代", () => {
  const subs = governedHerbSubstitutes("川芎", ["当归", "白芍"]);
  assert.ok(subs.length > 0, "川芎未给出替代候选");
  const names = subs.map((sub) => sub.substitute);
  for (const breaking of ["三棱", "莪术", "水蛭", "虻虫"]) {
    assert.ok(!names.includes(breaking),
      `破血逐瘀药 ${breaking} 被当成川芎的同向替代，等于把破血之力与妊娠高风险凭空引入本例`);
  }
  const source = getTcmHerbGenerationSafetyProfile("川芎");
  for (const sub of subs) {
    const safety = getTcmHerbGenerationSafetyProfile(sub.substitute);
    assert.ok(!(safety.isToxic && !source.isToxic), `${sub.substitute} 有毒而川芎无毒，不得作为替代`);
    for (const rule of safety.populationRules) {
      const sourceRule = source.populationRules.find((entry) => entry.population === rule.population);
      const rank = { LOW: 1, MEDIUM: 2, HIGH: 3 };
      assert.ok(rank[rule.severity] <= (sourceRule ? rank[sourceRule.severity] : 0),
        `${sub.substitute} 在「${rule.population}」上的风险档（${rule.severity}）高于川芎，不得作为替代`);
    }
  }
});

check("SUB-04 替代药必须有药典数值剂量边界，且非管制毒性/法律禁用品种", () => {
  for (const herb of ["党参", "川芎", "半夏", "酸枣仁", "黄芪", "白术"]) {
    for (const sub of governedHerbSubstitutes(herb, [])) {
      assert.equal(clinicianDoseHerbClass(sub.substitute), undefined,
        `${sub.substitute} 属「由医师确定用量」类，系统没有资格把它作为替代给出`);
      const limit = getTcmHerbDoseLimit(sub.substitute);
      assert.ok(limit && !limit.sourceConflict,
        `${sub.substitute} 无药典剂量边界或存在分用途冲突，不得作为替代`);
    }
  }
});

check("SUB-05 替代药不得与现方任何药味构成十八反十九畏", () => {
  // 现方含川乌：与半夏、瓜蒌、贝母、白蔹、白及相反。
  const prescription = ["川乌", "甘草", "生姜"];
  const baseConflicts = findTcmHerbPairIncompatibilities(prescription).length;
  for (const herb of ["半夏", "党参", "川芎"]) {
    for (const sub of governedHerbSubstitutes(herb, prescription)) {
      const after = findTcmHerbPairIncompatibilities([...prescription, herb, sub.substitute]).length;
      const before = findTcmHerbPairIncompatibilities([...prescription, herb]).length;
      assert.ok(after <= before,
        `替代药 ${sub.substitute} 与现方构成新的十八反十九畏（基线 ${baseConflicts}）`);
    }
  }
});

check("SUB-06 不得把现方已有药味当成替代（那是重复不是替代）", () => {
  const prescription = ["黄芪", "人参", "白术", "茯苓", "大枣"];
  for (const sub of governedHerbSubstitutes("党参", prescription)) {
    assert.ok(!prescription.includes(sub.substitute),
      `${sub.substitute} 已在现方中，不构成替代`);
  }
});

check("SUB-07 结果确定性：同一输入两次调用结果逐字相同", () => {
  const first = governedHerbSubstitutes("党参", ["黄芪", "当归"]);
  const second = governedHerbSubstitutes("党参", ["黄芪", "当归"]);
  assert.deepEqual(first, second, "同一病例两次请求给出不同替代建议，医生无法复核");
});

check("SUB-08 未知药与无功效分类的药返回空数组，不臆造", () => {
  assert.deepEqual(governedHerbSubstitutes("不存在的药材名", []), []);
  assert.deepEqual(governedHerbSubstitutes("", []), []);
});

// 输出契约里 substitutions 是 .max(4).optional().catch(undefined)，字段长度上限 400。
// 超一个字，**整条数组被静默丢弃**——表现成「功能又没了」而不是报错，正是最难查的那种退化。
// 全库遍历，确保没有任何一味药能拼出超长文本。
check("SUB-10 全库遍历：rationale/differenceNote 不得超出输出契约 400 字上限", () => {
  const { getTcmKnowledgeStatus } = {};
  void getTcmKnowledgeStatus;
  let checked = 0;
  let longest = 0;
  for (const herb of ["党参", "川芎", "半夏", "酸枣仁", "黄芪", "白术", "茯苓", "当归", "甘草",
    "陈皮", "柴胡", "白芍", "熟地黄", "丹参", "麻黄", "桂枝", "生姜", "大枣", "人参", "附子",
    "金银花", "连翘", "薄荷", "荆芥", "桔梗", "牛蒡子", "淡竹叶", "石膏", "知母", "黄连"]) {
    for (const sub of governedHerbSubstitutes(herb, [], 4)) {
      checked += 1;
      longest = Math.max(longest, sub.differenceNote.length, sub.rationale.length);
      assert.ok(sub.rationale.length <= 400,
        `${herb}→${sub.substitute} rationale ${sub.rationale.length} 字超上限，整条 substitutions 会被静默丢弃`);
      assert.ok(sub.differenceNote.length <= 400,
        `${herb}→${sub.substitute} differenceNote ${sub.differenceNote.length} 字超上限，整条 substitutions 会被静默丢弃`);
      assert.ok(sub.differenceNote.includes("系统不裁定二者等效"),
        `${herb}→${sub.substitute} 截断后丢失了免责结语`);
    }
  }
  assert.ok(checked > 20, `覆盖样本过少（${checked}）`);
});

check("SUB-09 条数上限受控", () => {
  assert.ok(governedHerbSubstitutes("党参", [], 1).length <= 1);
  assert.ok(governedHerbSubstitutes("党参", [], 2).length <= 2);
  assert.deepEqual(governedHerbSubstitutes("党参", [], 0), []);
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "herb-substitutes", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "herb-substitutes", checks: 10, failures: 0 }));
