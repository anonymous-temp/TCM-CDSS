// 方剂鉴别反证守卫(2026-08-04)。
//
// 由甲方实测缺陷驱动:无汗、脉浮紧的风寒**表实**病例仍被推荐「桂枝合剂」——
// 桂枝汤主治太阳中风表虚有汗,表实无汗恰是其法定禁忌(说明书原文「表实无汗…者禁服」)。
//
// 根因是**数据没被用上**:受治理鉴别图 167 条边里就有「桂枝汤 vs 麻黄汤:有汗/无汗、
// 脉缓/脉紧」,但它此前只喂提示词,从不做确定性判断。本套件钉住三件事:
//   1. 反证判定双向对称(不能只拦一侧,否则就是换个方向再犯同样的错);
//   2. 无关方零误报(守卫不能因为「拦得多」就算好);
//   3. 中成药候选表确定性排除方向相反的成药剂型。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { formulaCounterEvidence, counterEvidenceNotice, discriminationGraphCoverage, normalizeFormulaKey } =
  await jiti.import("../src/lib/formula-discrimination-guard.ts");
const { retrieveLocalPatentMedicineCandidates, governedClassicFormulaName } =
  await jiti.import("../src/lib/local-patent-medicine-candidates.ts");

let cases = 0;
let failures = 0;
const check = (name, fn) => { cases += 1; try { fn(); } catch (e) { failures += 1; console.error("FAIL", name, e?.message); } };

const EXTERIOR_EXCESS = "恶寒发热，无汗，头项强痛，周身疼痛，脉浮紧";
const EXTERIOR_DEFICIENT = "发热恶风，有汗，脉浮缓，鼻鸣干呕";

// 图规模自检:塌成 0 说明生成物或读取层坏了,不能静默放行(守卫恒返回空 = 静默失效)。
check("鉴别图规模自检", () => {
  const coverage = discriminationGraphCoverage();
  assert.ok(coverage.edges > 100, `鉴别图边数 ${coverage.edges} 异常偏低`);
  assert.ok(coverage.formulas > 100, `覆盖方剂数 ${coverage.formulas} 异常偏低`);
});

// 核心:双向对称。只拦一侧等于换个方向再犯同样的错。
check("表虚/表实反证双向对称", () => {
  const guiZhiOnExcess = formulaCounterEvidence("桂枝汤", EXTERIOR_EXCESS);
  assert.ok(guiZhiOnExcess, "表实无汗例必须对桂枝汤给出反证");
  assert.ok(guiZhiOnExcess.matchedAgainstTerms.includes("无汗"), "反证词应含「无汗」");
  assert.equal(formulaCounterEvidence("桂枝汤", EXTERIOR_DEFICIENT), undefined, "表虚有汗例不得反证桂枝汤");

  const maHuangOnDeficient = formulaCounterEvidence("麻黄汤", EXTERIOR_DEFICIENT);
  assert.ok(maHuangOnDeficient, "表虚有汗例必须对麻黄汤给出反证(对称性)");
  assert.ok(maHuangOnDeficient.matchedAgainstTerms.includes("有汗"), "反证词应含「有汗」");
  assert.equal(formulaCounterEvidence("麻黄汤", EXTERIOR_EXCESS), undefined, "表实无汗例不得反证麻黄汤");
});

// 零误报:守卫拦得多不等于好。无关病例、图外方剂都必须弃权。
check("无关病例与图外方剂弃权", () => {
  assert.equal(formulaCounterEvidence("归脾汤", "心悸失眠健忘，纳差便溏"), undefined, "无关病例不得误报");
  assert.equal(formulaCounterEvidence("查无此方汤", EXTERIOR_EXCESS), undefined, "图外方剂必须弃权而非驳回");
  assert.equal(formulaCounterEvidence("桂枝汤", ""), undefined, "空病历文本不得判反证");
});

// 加减写法必须归一,否则「桂枝汤加减」会绕过守卫。
check("加减/化裁写法归一", () => {
  for (const variant of ["桂枝汤加减", "桂枝汤加味", "桂枝汤（加味）", "桂枝汤 化裁"]) {
    assert.equal(normalizeFormulaKey(variant), "桂枝汤", variant);
    assert.ok(formulaCounterEvidence(variant, EXTERIOR_EXCESS), `${variant} 必须同样受守卫约束`);
  }
});

// 中成药通路:成药剂型必须继承其经典底方的反证。这是甲方原始缺陷的直接复现。
check("中成药候选排除方向相反的成药剂型", () => {
  assert.equal(governedClassicFormulaName("桂枝合剂"), "桂枝汤", "成药须能映射回受治理底方");
  const caseState = {
    chiefComplaint: "恶寒发热1天",
    symptoms: { 寒热: "恶寒发热，无汗", 头身: "头项强痛，周身疼痛" },
    tongue: "舌苔薄白",
    pulse: "脉浮紧",
    conversation: [],
    reasoningDiagnose: {
      overview: { primarySyndrome: "风寒束表证", primarySyndromeBasis: ["恶寒发热", "无汗", "脉浮紧"] },
      therapy: { overallMethod: "辛温解表，宣肺散寒" },
    },
  };
  const names = retrieveLocalPatentMedicineCandidates(caseState, 10).map((item) => item.name);
  assert.ok(
    !names.some((name) => name.includes("桂枝")),
    `表实无汗例不得推荐桂枝类成药，实际候选：${names.join("、") || "(空)"}`,
  );
});

// 医生可见文案:必须说明依据来源与「不代表一定错误」,不能写成硬判决。
check("反证提示文案是建议不是判决", () => {
  const notice = counterEvidenceNotice([formulaCounterEvidence("桂枝汤", EXTERIOR_EXCESS)]);
  assert.ok(notice.includes("无汗"), "文案须点出反证词");
  assert.ok(notice.includes("不代表一定错误"), "文案不得写成硬判决");
  assert.equal(counterEvidenceNotice([]), undefined, "无反证时不得产出文案");
});

console.log(JSON.stringify({ cases, failures, ...discriminationGraphCoverage() }));
if (failures > 0) process.exit(1);
