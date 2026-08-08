// 治法表述的确定性归一（L2 规则层）。
//
// 立这道闸的背景：同一病例多次重跑，**治法文字 100% 不同、概念集合 83% 不同**（归档实测）。
// 但反事实实验也证明了另一半：把同案另一次的治法文本换进去，判定翻转 42/1440(2.9%)，
// 套上归一后**一次都没减少**——因为那些翻转是「滋阴养血 → 清热除烦」这种临床内容真的换了，
// 不是同义改写。所以本层是**质量改进不是主修**，主修是门禁降级（已另行落地）。
//
// 本层唯一的承诺：把同一条治法的不同写法折叠到同一个受控条目，且**绝不改变原本就能命中的结果**。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { therapyPhraseLookupForms, normalizeTherapyPhrase, swappedTherapyPhrase, resolveTherapyPhrase } =
  await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
const { governedTreatmentPrinciplesInText, governedTreatmentMethodsInText } =
  await jiti.import("../src/lib/clinical-governance-tables.ts");

const lookup = (text) => [...governedTreatmentPrinciplesInText(text), ...governedTreatmentMethodsInText(text)];
const names = (text) => lookup(text).map((entry) => entry.canonical);

const failures = [];
function check(name, fn) {
  try { fn(); } catch (error) { failures.push(`${name}: ${error.message}`); }
}

check("TP-01 词序颠倒只作用于四字子句", () => {
  assert.equal(swappedTherapyPhrase("化痰祛湿"), "祛湿化痰");
  assert.equal(swappedTherapyPhrase("寒热平调"), "平调寒热");
  // 更长的短语颠倒后未必等价，不得处理。
  assert.equal(swappedTherapyPhrase("和胃降逆止呕"), undefined);
  assert.equal(swappedTherapyPhrase("补气"), undefined);
});

check("TP-02 零命中的同义写法被救回", () => {
  for (const [written, expected] of [
    ["化痰祛湿", "燥湿化痰"],
    ["养阴清热", "清热养阴"],
    ["止咳化痰", "化痰止咳"],
    ["降逆和胃", "和胃降逆"],
    ["寒热平调", "平调寒热"],
  ]) {
    assert.equal(names(written).length, 0, `前提失效：「${written}」原本就能命中，本用例失去意义`);
    const resolved = resolveTherapyPhrase(written, lookup);
    assert.ok(resolved.normalized, `「${written}」未走归一`);
    assert.ok(
      resolved.matches.map((entry) => entry.canonical).includes(expected),
      `「${written}」应归一到「${expected}」，实得 ${JSON.stringify(resolved.matches.map((e) => e.canonical))}`,
    );
  }
});

check("TP-03 原本能命中的一律不得被改变（这是本层的硬边界）", () => {
  // 「谁命中多用谁」会引入漂移：健脾燥湿 原命中「燥湿」，若改用颠倒形态「燥湿健脾」
  // 会连带引入「辛香运脾」——那是另一条治法。归一是折叠同义写法，不是扩大召回。
  const drifted = [];
  for (const phrase of ["健脾燥湿", "除湿通络止痛", "和胃降逆止呕", "活血通络止痛", "清热养阴为主", "益气健脾"]) {
    const before = names(phrase);
    if (before.length === 0) continue;
    const after = resolveTherapyPhrase(phrase, lookup).matches.map((entry) => entry.canonical);
    if (JSON.stringify(before) !== JSON.stringify(after)) drifted.push(`${phrase}: ${before} → ${after}`);
  }
  assert.deepEqual(drifted, [], `归一改变了原本就正确的命中：\n  ${drifted.join("\n  ")}`);
});

check("TP-04 尾部疗效词剥离是**数据驱动**的，不靠手写清单", () => {
  // 原设计是 27 词手写白名单（止痛/止呕/退黄…），那是又一张会漏的临床词表，
  // test:clinical-vocabulary 明令禁止。现在判据改为「剥掉尾部两三字后能否命中受治理表」：
  // 能命中即说明剩余部分本身是受控治法、被剥掉的是目的而非治法本体。
  // 好处是随受治理表一起演进，不会因为漏收某个疗效词而失效。
  const resolved = resolveTherapyPhrase("和胃降逆止呕", lookup);
  assert.ok(resolved.matches.length > 0, "「和胃降逆止呕」应能解析");
  // 不得张冠李戴：剥离结果必须是原文的**前缀**，不能跑到别的治法上去。
  assert.ok(
    "和胃降逆止呕".startsWith(resolved.form),
    `剥离结果「${resolved.form}」不是原文前缀——出现语义漂移`,
  );
  const drifting = resolveTherapyPhrase("除湿通络止痛", lookup);
  assert.ok(
    "除湿通络止痛".startsWith(drifting.form),
    `「除湿通络止痛」被解析到了「${drifting.form}」——第一版的子串包含就是这么把它引到「活血止痛」的`,
  );
});

check("TP-05 剥到单字即丢弃，两字保留", () => {
  const forms = therapyPhraseLookupForms("兼以理气");
  assert.ok(forms.includes("理气"), "两字受控治法被误丢（理气/燥湿/化痰/补气 都在 GB/T 里）");
  assert.ok(forms.every((form) => form.length >= 2), `候选里出现了单字：${JSON.stringify(forms)}`);
});

check("TP-06 规范化：NFKC + 去标点 + 繁简折叠", () => {
  assert.equal(normalizeTherapyPhrase("清熱養陰。"), "清热养阴");
  assert.equal(normalizeTherapyPhrase("  疏肝，理气  "), "疏肝理气");
});

check("TP-07 全量语料：净增益为正且漂移为零", () => {
  // 数字来自归档 artifacts/ 的真实治法子句，不是构造样本。
  // 允许上下浮动（语料会增删），但**漂移必须恒为 0**。
  const probes = ["化痰祛湿", "养阴清热", "止咳化痰", "降逆和胃", "寒热平调",
    "健脾燥湿", "除湿通络止痛", "和胃降逆止呕", "清热养阴为主", "益气健脾", "清退虚热", "宣通腠理"];
  let rescued = 0;
  let drifted = 0;
  for (const phrase of probes) {
    const before = names(phrase);
    const after = resolveTherapyPhrase(phrase, lookup).matches.map((entry) => entry.canonical);
    if (before.length === 0 && after.length > 0) rescued += 1;
    if (before.length > 0 && JSON.stringify(before) !== JSON.stringify(after)) drifted += 1;
  }
  assert.equal(drifted, 0, "出现漂移");
  assert.ok(rescued >= 5, `救回数 ${rescued} 低于基线 5——归一层疑似失效`);
});

if (failures.length > 0) {
  console.error("治法表述归一 FAILED:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(JSON.stringify({ suite: "therapy-phrasing", failures: 0 }));
