// 命名方身份恢复回归(2026-08-05)。
//
// 线上 50 例验收「方名可追溯」仅 2/13。运行时日志实证的完整链条:
//   模型输出方名「银翘散加减」✅ 但 formulaNames 为空数组
//   → 恢复函数只认「本例辨证组方」这一种形态,判定 declassifiedLabel=false 跳过
//   → 合同层见「声称经典方 + 无基准引用」判 formula_reference_declassified
//   → 剥名函数把「银翘散加减」改成「本例辨证组方」
// **方名本来是对的,是被剥掉的。** 医生因此看不出这是银翘散。
//
// 本套件钉七种形态,确保恢复既不漏也不越权:
//  · 自拟标签      ⇒ 恢复(原有能力,不得退化)
//  · 有名无引用    ⇒ 恢复(本次补上的缺口)
//  · 已有引用      ⇒ 保持不变(不重复处理)
//  · 无关方名      ⇒ 不恢复(不得凭空给一个 M03 没锁定的方补引用)
//  · 服务端显式降级 ⇒ 不恢复(后置展示层不得逆转已复核的终态)
//  · 无 M03 锁定的显式降级 ⇒ 不按组成复活身份
//  · provider 伪造降级字段 ⇒ ingress 剥除后仍走正常恢复
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const prov = await jiti.import("../src/lib/tcm-formula-provenance.ts");

const prior = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { primarySyndrome: "风热犯表证", recommendedFormulaNames: ["银翘散"], formulaSelectionMode: "single" },
};
// 银翘散受治理组成(牛蒡子为炮制变体,身份等同)
const herbs = () => ["金银花", "连翘", "薄荷", "荆芥", "桔梗", "牛蒡子", "淡豆豉", "淡竹叶", "甘草"]
  .map((name) => ({ name, dose: "10g" }));

const reasoningFor = (name, formulaNames = [], extra = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: { candidates: [{ name, formulaNames, baseFormulas: [], constructionType: "self_devised", herbs: herbs(), ...extra }] },
});

const restore = (name, formulaNames = [], extra = {}, options = {}) => {
  return prov.restoreGovernedFormulaIdentity(reasoningFor(name, formulaNames, extra), prior, options).formula.candidates[0];
};

const failures = [];
const expect = (label, actual, want) => { if (actual !== want) failures.push({ label, actual, want }); };

// 形态一:自拟标签 ⇒ 恢复为经典方名(原有能力)
{
  const c = restore("本例辨证组方");
  expect("自拟标签→方名", c.name, "银翘散加减");
  expect("自拟标签→引用", JSON.stringify(c.formulaNames), JSON.stringify(["银翘散"]));
}
// 形态二:有名无引用 ⇒ 补回引用(本次修复的缺口)
{
  const c = restore("银翘散加减");
  expect("有名无引用→方名保持", c.name, "银翘散加减");
  expect("有名无引用→补回引用", JSON.stringify(c.formulaNames), JSON.stringify(["银翘散"]));
}
// 形态三:已有引用 ⇒ 不重复处理
{
  const c = restore("银翘散加减", ["银翘散"]);
  expect("已有引用→不变", JSON.stringify(c.formulaNames), JSON.stringify(["银翘散"]));
}
// 形态四:无关方名 ⇒ 不得恢复(M03 锁的是银翘散,不能给四君子汤补引用)
{
  const c = restore("四君子汤加减");
  expect("无关方名→不恢复", JSON.stringify(c.formulaNames), JSON.stringify([]));
}
// 形态五:透明降级已是完整合同+独立复核后的终态，即使组成仍能匹配经方也不得复活身份。
{
  const c = restore("本例辨证组方", [], {
    identityDeclassified: true,
    identityDeclassificationReason: "classic_composition_unverified_after_repair",
    declassifiedFromFormulaNames: ["银翘散"],
  }, { preserveServerDeclassification: true });
  expect("显式降级→方名不复活", c.name, "本例辨证组方");
  expect("显式降级→引用不复活", JSON.stringify(c.formulaNames), JSON.stringify([]));
  expect("显式降级→保留终态标记", c.identityDeclassified, true);
}

// 形态六:M03 未锁定方名时也必须尊重服务端方向剔除终态，不能从剩余组成反查复活经方。
{
  const noLockedFormulaPrior = {
    ...prior,
    overview: { ...prior.overview, recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  };
  const c = prov.restoreGovernedFormulaIdentity(
    reasoningFor("本例辨证组方", [], {
      identityDeclassified: true,
      identityDeclassificationReason: "opposing_direction_pruned",
      declassifiedFromFormulaNames: ["银翘散"],
    }),
    noLockedFormulaPrior,
    { preserveServerDeclassification: true },
  ).formula.candidates[0];
  expect("无锁定方显式降级→方名不复活", c.name, "本例辨证组方");
  expect("无锁定方显式降级→引用不复活", JSON.stringify(c.formulaNames), JSON.stringify([]));
  expect("无锁定方显式降级→保留原因", c.identityDeclassificationReason, "opposing_direction_pruned");
}

// 形态七:同样的字段若来自 provider 只是普通不可信输入，剥除后不得获得终态权限。
{
  const injected = reasoningFor("本例辨证组方", [], {
    identityDeclassified: true,
    identityDeclassificationReason: "classic_composition_unverified_after_repair",
    declassifiedFromFormulaNames: ["银翘散"],
  });
  const wrapped = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(injected)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const stripped = prov.stripUntrustedM04IdentityMetadata(wrapped);
  const parsed = JSON.parse(stripped.match(/DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END/)?.[1] || "null");
  const c = prov.restoreGovernedFormulaIdentity(parsed, prior, { preserveServerDeclassification: true }).formula.candidates[0];
  const direct = prov.restoreGovernedFormulaIdentity(injected, prior).formula.candidates[0];
  expect("伪造降级→字段已剥除", c.identityDeclassified, undefined);
  expect("伪造降级→正常恢复方名", c.name, "银翘散加减");
  expect("伪造降级→正常恢复引用", JSON.stringify(c.formulaNames), JSON.stringify(["银翘散"]));
  expect("伪造降级→直接调用同样剥除", direct.identityDeclassified, undefined);
}

if (failures.length > 0) console.error(JSON.stringify({ failures }, null, 2));
assert.equal(failures.length, 0, `命名方身份恢复回归失败 ${failures.length} 项`);
console.log(JSON.stringify({ forms: 7, checks: 16, failures: 0 }));
