// PHI 脱敏与临床术语的撞车回归(2026-08-05)。
//
// 甲方实测链路:西医「支持依据」只剩半句病历原文、总体病机缺节点。追下去发现问题不在 M03,
// 而在**送模型之前**——脱敏规则把临床事实当人名抹掉了,模型根本没看到:
//
//   「主诉：周身出现块状皮疹」→「主诉：[已脱敏]出现块状皮疹」
//    周在姓氏表、身是 1 字、出现在叙述动词表 ⇒ 命中「姓氏字+1~2字+叙述动词」分支。
//   「患者，女，36岁」→「[已脱敏]，女，36岁」
//    「患者」是通用指代词,不携带任何身份信息,抹掉只制造噪声。
//
// 20 例线上语料实测 13 例命中,周身/全身/白苔/黄疸/皮疹/干呕这些词**都不在任何受控词表里**,
// 靠补词表穷举不完。判据改成**位置**:本系统病历按字段录入,姓名在 patient 字段或带显式
// 「姓名：」标签,不会紧跟在「主诉：」「四诊：」「舌：」之后。
//
// 本套件双向钉死,任一方向失守都不可接受:
//  · 临床事实不得被当人名抹掉(抹掉 = 模型看不到 = 后面每一层都补不回来);
//  · 真实姓名必须照常脱敏(漏掉 = PHI 泄露)。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");

const scrub = (text) => {
  const state = {
    id: "phi-collision-test",
    patient: { sex: "女", age: 30 },
    chiefComplaint: text,
    symptoms: { 现病史: text },
    tongue: "",
    pulse: "",
    conversation: [],
    vitals: {},
  };
  return String(safety.sanitizeCaseStateForModel(state).symptoms?.现病史 || "");
};

const failures = [];
const expectKept = (text, why) => {
  const out = scrub(text);
  if (out.includes("脱敏")) failures.push({ kind: "clinical_fact_lost", text, why, out });
};
const expectRedacted = (text, why) => {
  const out = scrub(text);
  if (!out.includes("脱敏")) failures.push({ kind: "phi_leak", text, why, out });
};

// ── 一、临床字段标签之后的词不得被当人名(甲方缺陷本体) ─────────────────
expectKept("主诉：周身出现块状皮疹已持续一年多", "周身是病位事实,丢了会改变辨证");
expectKept("四诊：舌质淡红，苔薄白，脉细数，风团红痒", "四诊原文不得被裁剪");
expectKept("现病史：干呕反复发作3日", "干呕:干在姓氏表");
expectKept("症见：白苔满布，口淡不渴", "白苔:白在姓氏表");
expectKept("查体：黄疸出现于巩膜及全身皮肤", "黄疸/全身:黄在姓氏表");

// ── 二、通用指代词不是姓名 ────────────────────────────────────
expectKept("患者，女，36岁，已婚。两次月经中间，阴道少量出血", "「患者」不携带身份信息");
expectKept("患儿，男，5岁。发热2天", "「患儿」同上");

// ── 三、真实姓名必须照常脱敏(收紧不得变成泄露) ────────────────────
expectRedacted("王某，女性，26岁。1个月前出现发热", "某字名");
expectRedacted("张三昨夜失眠", "姓名 + 叙述动词,无临床标签前缀");
expectRedacted("患者王小明今日来诊", "指代词标签 + 姓名");
expectRedacted("姓名：李建国，男，52岁", "显式姓名标签");
expectRedacted("联系人：陈美玲，电话13800138000", "联系人标签 + 手机号");
expectRedacted("患者赵德海，男，68岁，因胸痛来诊", "姓氏 + 人口学邻接");

if (failures.length > 0) {
  console.error(JSON.stringify({ failures }, null, 2));
}
assert.equal(
  failures.length, 0,
  `PHI/临床术语撞车回归失败 ${failures.length} 项。clinical_fact_lost = 临床事实被当人名抹掉` +
  `(模型看不到,后面补不回来);phi_leak = 真实姓名未脱敏(隐私泄露)。两类都不可接受。`,
);

console.log(JSON.stringify({
  clinicalFactsPreserved: 7,
  realNamesRedacted: 6,
  failures: 0,
}));
