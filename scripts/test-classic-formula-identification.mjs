// 按组成反查经方（甲方 2026-08-05 R1 / M5.1 / M5.2）。
//
// 甲方口径：「首选经方名，如确认无对应的经方，走自拟方」。
// 实测投诉：「该方为麻黄汤加味，展示为自拟方？」
//
// 根因：restoreGovernedFormulaIdentity 只在 **M03 已锁定方名**时进场。M03 判自拟
// （formulaSelectionMode=self_devised）时它直接 return，于是 M04 即便组出一张标准麻黄汤，
// 也只能顶着「本例辨证组方」出去——系统认得这个方，只是从来没按组成回头查过。
//
// 本套件同时钉住实现过程中**真实发生过的两次误判**，它们是这类反查最容易踩的坑：
//  1) 直接套用正向的 80% 覆盖阈值 → 麻黄汤被识别成「桂枝汤加减」（缺白芍仍放行）。
//     麻黄汤与桂枝汤正是本仓库 formula-discrimination-guard 双向互斥的表实/表虚对，
//     把无汗表实的方冠上有汗表虚的名，比不识别严重得多。
//  2) 纯按计数排序 → 麻黄汤加味被识别成「桂枝去芍药汤加味」（基准味数与增味数完全相同）。
//     判别点在于把**麻黄**当作普通「增味」不成立：它是安全定性药味，加它等于改变全方性质。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { identifyGovernedFormulaByComposition, restoreGovernedFormulaIdentity } =
  await jiti.import("../src/lib/tcm-formula-provenance.ts");

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

const herbs = (...names) => names.map((name) => ({ name }));

check("CFI-01 原方组成识别为经方本名，不加「加味」后缀", () => {
  const result = identifyGovernedFormulaByComposition(herbs("麻黄", "桂枝", "苦杏仁", "炙甘草"));
  assert.ok(result, "标准麻黄汤未被识别");
  assert.equal(result.formulaName, "麻黄汤");
  assert.equal(result.displayName, "麻黄汤");
  assert.equal(result.modificationKind, "canonical");
  assert.deepEqual(result.extraIngredients, []);
});

// 甲方 M5.2 原始投诉例。
check("CFI-02 麻黄汤加味必须识别为麻黄汤加味，绝不能识别成桂枝类方", () => {
  const result = identifyGovernedFormulaByComposition(
    herbs("麻黄", "桂枝", "苦杏仁", "炙甘草", "生姜", "大枣"));
  assert.ok(result, "麻黄汤加味未被识别，仍会显示为自拟方");
  assert.equal(result.formulaName, "麻黄汤", `识别成了 ${result.formulaName}`);
  assert.equal(result.displayName, "麻黄汤加味");
  assert.equal(result.modificationKind, "加味");
  assert.deepEqual(result.extraIngredients.sort(), ["大枣", "生姜"]);
  assert.ok(!/桂枝汤|桂枝去芍药汤/.test(result.formulaName),
    "识别成桂枝类方等于把无汗表实证的方冠上有汗表虚证的名");
});

check("CFI-03 炮制品与别名两侧统一：苦杏仁/杏仁、炙甘草/甘草", () => {
  // 目录里麻黄汤是〔麻黄、桂枝、甘草、杏仁〕，临床开的是〔苦杏仁、炙甘草〕。
  const withProcessing = identifyGovernedFormulaByComposition(herbs("麻黄", "桂枝", "苦杏仁", "炙甘草"));
  const withBase = identifyGovernedFormulaByComposition(herbs("麻黄", "桂枝", "杏仁", "甘草"));
  assert.ok(withProcessing && withBase, "炮制/别名任一形态漏识");
  assert.equal(withProcessing.formulaName, withBase.formulaName, "同一张方因炮制写法不同得到不同方名");
});

check("CFI-04 缺一味即不认——完整包含是硬判据", () => {
  // 桂枝汤 = 桂枝、白芍、炙甘草、生姜、大枣。去掉白芍后不得再叫桂枝汤。
  const result = identifyGovernedFormulaByComposition(herbs("桂枝", "炙甘草", "生姜", "大枣", "饴糖"));
  assert.ok(!result || result.formulaName !== "桂枝汤",
    `缺白芍仍被识别为桂枝汤：${result?.displayName}`);
});

check("CFI-05 增味不得超过基准味数", () => {
  const result = identifyGovernedFormulaByComposition(herbs(
    "麻黄", "桂枝", "苦杏仁", "炙甘草",
    "金银花", "连翘", "薄荷", "荆芥", "桔梗",
  ));
  assert.ok(!result || result.formulaName !== "麻黄汤",
    `4 味基准 + 5 味增味仍冠以麻黄汤名：${result?.displayName}`);
});

check("CFI-06 单味/两味方不得命中任何含该药的处方", () => {
  const result = identifyGovernedFormulaByComposition(herbs("甘草", "黄芪", "当归", "白术", "茯苓"));
  if (result) {
    assert.ok(result.baselineCount >= 3, `${result.formulaName} 只有 ${result.baselineCount} 味基准，属误报`);
  }
});

check("CFI-07 确无对应经方时返回 undefined（甲方：走自拟方）", () => {
  assert.equal(identifyGovernedFormulaByComposition(herbs("丁香", "刺五加", "儿茶")), undefined);
  assert.equal(identifyGovernedFormulaByComposition(herbs("黄芪", "当归")), undefined, "少于三味不识别");
  assert.equal(identifyGovernedFormulaByComposition([]), undefined);
});

check("CFI-08 结果确定性：同一处方两次识别逐字相同", () => {
  const input = herbs("麻黄", "桂枝", "苦杏仁", "炙甘草", "生姜", "大枣");
  assert.deepEqual(
    identifyGovernedFormulaByComposition(input),
    identifyGovernedFormulaByComposition(input),
    "同一处方两次调用得到不同方名，医生无从复核",
  );
});

// —— 端到端：M03 判自拟时，M04 的自拟标签必须被组成反查改写 ——

const priorSelfDevised = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndrome: "风寒表实证",
    primarySyndromeResolution: "resolved",
    primarySyndromeBasis: ["恶寒发热无汗"],
    overallPathogenesis: "风寒束表",
    overallTherapy: "辛温解表",
    recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
    recommendedFormulaNames: [],
    formulaSelectionMode: "self_devised",
    evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" },
  },
  pathogenesis: { chain: [] },
};

function prescribeWith(name, herbNames) {
  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    formula: {
      candidates: [{
        name,
        formulaNames: [],
        positioning: "首选",
        constructionType: "self_devised",
        herbs: herbNames.map((herb) => ({ name: herb, dose: "6g", role: "臣" })),
      }],
    },
  };
}

check("CFI-09 M03 自拟 + 组成为经方 ⇒ 恢复经方名（甲方 M5.2 端到端）", () => {
  const restored = restoreGovernedFormulaIdentity(
    prescribeWith("本例辨证组方", ["麻黄", "桂枝", "苦杏仁", "炙甘草", "生姜", "大枣"]),
    priorSelfDevised,
  );
  const candidate = restored.formula.candidates[0];
  assert.equal(candidate.name, "麻黄汤加味", `仍显示为 ${candidate.name}`);
  assert.deepEqual(candidate.formulaNames, ["麻黄汤"]);
  assert.equal(candidate.constructionType, "single_base");
  assert.equal(candidate.modificationStatus, "modified");
});

check("CFI-10 确无对应经方时保持自拟，不臆造方名", () => {
  const restored = restoreGovernedFormulaIdentity(
    prescribeWith("本例辨证组方", ["丁香", "刺五加", "儿茶"]),
    priorSelfDevised,
  );
  assert.equal(restored.formula.candidates[0].name, "本例辨证组方");
  assert.deepEqual(restored.formula.candidates[0].formulaNames, []);
});

check("CFI-11 方名已由模型写明时不覆盖——不替人做方剂裁定", () => {
  const restored = restoreGovernedFormulaIdentity(
    prescribeWith("麻黄汤合桂枝汤化裁", ["麻黄", "桂枝", "苦杏仁", "炙甘草", "生姜", "大枣"]),
    priorSelfDevised,
  );
  assert.equal(restored.formula.candidates[0].name, "麻黄汤合桂枝汤化裁",
    "模型已给出的合方判断不得被服务端改写");
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "classic-formula-identification", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "classic-formula-identification", checks: 11, failures: 0 }));
