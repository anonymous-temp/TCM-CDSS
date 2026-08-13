// 可替换药味的确定性推导与安全边界（甲方 2026-08-05「随证加减建议——可增加：可替换药味的说明」）。
//
// 这条需求此前是**假闭环**：提交 ff541cb0 加了 TS 字段 modifications[].substitutions 与文档描述，
// 但 M04 提案 zod schema 里根本没声明该字段，模型即使输出也被 strip；编译器构造的字面量也不带它。
// 于是「可替换药味出参」从未产生过任何一条值。本套件按「真的有值，且值是安全的」来断言。
//
// 安全立场：替代药**绝不能由模型提名**——那等于让模型开药。候选完全由受治理数据推导，
// 并逐条过硬边界。以下每一条断言删掉都会让系统获得"凭同类就换药"的能力。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  governedHerbSubstitutes,
  getTcmHerbDoseLimit,
  clinicianDoseHerbClass,
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

// ── 2026-08-13 甲方裁定后改判：候选来源从「教材功效归类表笛卡尔推导」换成受治理临床替代裁定表 ──
//
// 甲方线上实测：医生界面出现 薄荷→升麻/大豆黄卷、杜仲→冬虫夏草/巴戟天、紫苏叶→白芷、
// 车前子→川木通。功效分类近似 ≠ 本例可替换，杜仲→冬虫夏草尤其不该出现在医生界面。
// 甲方要求「取消自动展示的类别级替换，只有存在明确方义、适应证和剂量依据的替代关系才展示」。
//
// 原 SUB-01/02/03/10 四条钉的是那套推导的内部性质（同类锚定、最具体分类、风险不升级、
// 全库遍历字数）。推导删除后它们钉的东西已不存在——**留着会逼后人把缺陷改回来**，故改判为
// 钉新契约：空表即不展示；安全过滤链不得因表空而被顺手删掉；签字后才可能出现候选。
check("SUB-01 未签字裁定表 ⇒ 一条替代都不给（甲方要求的默认值，不是功能缺失）", () => {
  for (const [herb, prescription] of [
    ["党参", ["黄芪", "当归", "白术", "茯苓"]],
    ["半夏", ["陈皮", "茯苓"]],
    ["川芎", ["当归", "白芍"]],
    ["薄荷", ["金银花", "连翘"]],
    ["杜仲", ["续断", "桑寄生"]],
    ["紫苏叶", ["荆芥", "防风"]],
    ["车前子", ["茯苓", "泽泻"]],
  ]) {
    const subs = governedHerbSubstitutes(herb, prescription);
    assert.deepEqual(
      subs, [],
      `${herb} 在裁定表为空时仍给出替代 ${JSON.stringify(subs.map((s) => s.substitute))}——` +
      "类别级推导必须已经删除，甲方点名的四组误推（薄荷→升麻、杜仲→冬虫夏草…）正出自它",
    );
  }
});

check("SUB-02 候选来源必须是受治理裁定表，且只认已签字条目", () => {
  const source = readFileSync(new URL("../src/lib/tcm-knowledge.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function governedHerbSubstitutes(");
  assert.ok(start > 0, "找不到 governedHerbSubstitutes——函数改名时本判据必须跟着改");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.ok(
    body.includes("CLINICAL_SUBSTITUTION_BY_HERB"),
    "候选来源必须取自受治理临床替代裁定表",
  );
  assert.ok(
    !/herbsByFunctionCategory/.test(source),
    "教材功效归类表的替代推导索引必须已整体删除，否则随时会被接回去",
  );
  assert.ok(
    /status !== "clinician_approved"/.test(source),
    "裁定表必须只认 clinician_approved 条目——未签字不得展示",
  );
});

check("SUB-03 安全过滤链不得因裁定表为空而被删（签字后即刻生效）", () => {
  const source = readFileSync(new URL("../src/lib/tcm-knowledge.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function governedHerbSubstitutes(");
  const body = source.slice(start, source.indexOf("\n}", start));
  for (const [guard, why] of [
    ["clinicianDoseHerbClass", "「由医师确定用量」/管制毒性/法律禁用三类必须出局"],
    ["getTcmHerbDoseLimit", "替代药必须有药典数值剂量边界且无分用途冲突"],
    ["findTcmHerbPairIncompatibilities", "替代药与现方全部药味及被替换药都不得构成十八反十九畏"],
    ["governedRiskCodes", "替代药不得引入原药没有的风险码"],
    ["SAFETY_SEVERITY_RANK", "同一人群的风险档位不得高于原药"],
  ]) {
    assert.ok(body.includes(guard), `安全过滤缺失：${guard} —— ${why}`);
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
check("SUB-10 输出契约字数上限的守卫保留（裁定表签字后重新生效）", () => {
  // 原判据全库遍历所有类别推导结果，检查 rationale/differenceNote ≤400 字。
  // 推导删除后覆盖样本恒为 0，遍历断言会变成空转；改为钉住**截断逻辑仍在**，
  // 等中医师签字后该逻辑立刻对真实条目生效（超一个字整条 substitutions 会被 schema 静默丢弃）。
  const source = readFileSync(new URL("../src/lib/tcm-knowledge.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function governedHerbSubstitutes(");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.ok(/NOTE_LIMIT\s*=\s*400/.test(body), "400 字预算常量必须保留");
  assert.ok(body.includes("clip("), "截断函数必须仍被使用");
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
