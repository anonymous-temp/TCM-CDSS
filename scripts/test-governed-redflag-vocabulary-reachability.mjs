/**
 * 受治理红旗词表的**可达性**：表里声明的词，确定性门禁必须真的能说出话来。
 *
 * 【断言对象是行为，不是源码形状】
 * 本仓已有多条「必须读受治理表」的源码级断言（心血管慢性稳定降级、L4 阻断词表…）。
 * 那类断言钉的是实现：重构一次改一次，而且钉住了实现也**证明不了覆盖**——
 * 一个分支可以老老实实读表，却因为上游合取条件永远不成立而一个字都不出。
 * 这里直接问最终问题：这个词写进病历，三个出口（红旗/提示/待评估）到底会不会吭声。
 *
 * 【实测缺陷（2026-08-17）】收敛前逐词灌进 evaluateSafetyGate，**13 个词三个出口全为 0**：
 *   shock       低血压、休克、循环灌注不足     ← 病历直接写「休克」二字，门禁一声不吭
 *   anaphylaxis 喉头水肿、喉咙肿、喘鸣         ← 行内写「喉头肿胀」，表里是「喉头水肿」
 *   obstetric   妊娠出血、孕期阴道出血         ← 行内写「阴道流血」，表里是「阴道出血」
 *   metabolic   高渗状态、代谢紊乱
 *   neuro       剧烈头痛      pediatric  拒食拒饮      cardiac  胸闷（见豁免）
 * 全部源于「受治理表一份、narrativeFallbackAdvisories 行内字面量一份」分叉，
 * 「肿胀 vs 水肿」「流血 vs 出血」这种一字之差正是这种缺陷最典型的样子。
 * 修法是让分支读表，不是手工补这 12 个词——补词只把分叉推迟一代。
 *
 * 【为什么不是「每个词裸着都必须报」】词表 governance.scopeNote 自己写着：
 *   「不得将所有急迫词与所有症状做无差别笛卡尔积；每类红旗必须按 categoryRules 独立组合
 *     并保留否定、时态、主体和缓解边界。」
 * 且每个类目自带 qualifiers。acute_abdomen 的 qualifiers 是 [acuteOnset, severe, current]，
 * 所以「胃脘痛」裸词不报**是表规定的**，不是漏——它是中医门诊第一高频主诉，
 * 裸词即报等于每个病人都弹红旗。故本套件分两层断言：
 *   ① 组合层（通用不变量）：症状 + 该类目 dangerCompanions[0] + 急性/当前限定 ⇒ 必须可达。
 *      实测这层在修复前有 2 条静默、修复后 0 条，不空转。
 *   ② 裸词层（本次收敛的回归钉）：除下方逐条写明理由的豁免外，其余必须裸词即可达。
 *      修复前 13 条无理由静默，修复后仅剩豁免项。
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
const { evaluateSafetyGate, narrativeFallbackAdvisories } = await jiti.import("../src/lib/diagnosis-safety.ts");
const lexicon = JSON.parse(readFileSync(path.join(repoRoot, "src/data/redflag-triage-lexicon.json"), "utf8"));

/**
 * 这两个类目的 symptoms 不是自由文本词汇，用文本去探是**用错了仪器**：
 * vital_instability 的「危急血压/极端体温」是测量档标签（hardGateRequires=
 * validated_contextual_vital_threshold），走生命体征解析——本文件第 4 节用真实体征另行验证；
 * other_critical 的 hardGateRequires 明写 explicit_deterministic_rule_or_manual_clinician_escalation_only，
 * 即设计上就没有自动检出，只能由确定性规则或医生手动升级。
 */
const NON_TEXT_CATEGORIES = new Set(["vital_instability", "other_critical"]);

/**
 * 裸词层豁免。**每条必须写明理由，且理由必须是有意的临床权衡或表自身的 qualifiers，
 * 不能是「还没修」。** 豁免过期（该词变得可达）会让本套件报错，逼人回来删豁免——
 * 留着过期豁免会掩盖将来真正的回退。
 */
const BARE_EXEMPT = new Map([
  ["cardiac::胸闷", "门诊高频非特异主诉（痰湿/气滞/心脾两虚都会写）；同类目「胸痛」裸词即报红旗，此不对称为刻意权衡"],
  ["sepsis::高热", "sepsis.qualifiers=[current,severe]；单独发热在门诊过于常见，按表要求与寒战合取"],
  ["sepsis::寒战", "同上，与发热/实测体温≥38.5℃ 合取"],
  ["sepsis::感染", "「感染」过于宽泛（上感/皮肤感染均含此词），按表 qualifiers 需合取"],
  ...["腹痛", "腹胀", "胃痛", "胃脘痛", "肚子疼", "右下腹痛", "上腹痛", "心口窝痛", "胃部疼痛"].map(
    (term) => [`acute_abdomen::${term}`,
      "acute_abdomen.qualifiers=[acuteOnset,severe,current]，表明确要求限定词；"
      + "「胃脘痛」是中医门诊第一高频主诉，裸词即报等于每个病人都弹红旗"],
  ),
]);

const caseFor = (complaint, pediatric = false, vitals = "") => ({
  id: "reach", phase: "collect", patient: { sex: "男", age: pediatric ? 6 : 45 },
  chiefComplaint: complaint, symptoms: { general: complaint, tcmFourExams: "" },
  tongue: "", pulse: "", vitals, labs: "",
  pastHistory: "", medicationHistory: "", allergyHistory: "",
  questionRounds: 1, maxQuestionRounds: 1, conversation: [],
  diagnosis: "", prescription: "", riskAssessment: "",
});

const outletCount = (gate) =>
  (gate.redFlags || []).length
  + (gate.advisories || gate.fallbackAdvisories || []).length
  + (gate.priorityEvaluationItems || []).length;

const textCategories = lexicon.categoryRules.filter((rule) => !NON_TEXT_CATEGORIES.has(rule.id));
const totalSymptoms = textCategories.reduce((sum, rule) => sum + (rule.symptoms || []).length, 0);
// 规模守卫：词表若被缩减，上面两层断言都会静默空转（本仓踩过——从第一张表删一项，
// 断言却在第二张表里找到了同名项，全程绿）。
assert.ok(
  textCategories.length >= 15 && totalSymptoms >= 80,
  `受治理词表规模异常：文本类目 ${textCategories.length} 个 / 症状 ${totalSymptoms} 条——表被缩减会让本套件空转`,
);

// ── 1. 组合层：按词表自身的组合规则，每个症状词都必须可达 ──────────────────
{
  const silent = [];
  for (const rule of textCategories) {
    const companion = (rule.dangerCompanions || [])[0];
    for (const symptom of rule.symptoms || []) {
      const text = companion ? `突发${symptom}，伴${companion}，持续至今` : `突发${symptom}，持续至今`;
      const gate = evaluateSafetyGate(caseFor(text, rule.id === "pediatric_critical"));
      if (outletCount(gate) === 0) silent.push(`${rule.id}::${symptom}`);
    }
  }
  assert.deepEqual(
    silent, [],
    "以下受治理症状词即使按词表自身的组合规则（症状 + 该类目危险伴随症 + 急性/当前限定）书写，"
    + `红旗/提示/待评估三个出口仍一个字都不出：\n  ${silent.join("\n  ")}\n`
    + "受治理表是检出词表的唯一声明来源（升不升到硬门由 hardGateRequires 决定）；"
    + "表里有而门禁全静默 = 行内字面量又与表分叉了。修法是让分支读表，不是手工补词。",
  );
}

// ── 2. 裸词层：本次收敛的回归钉 ────────────────────────────────────────────
{
  const silent = [];
  for (const rule of textCategories) {
    for (const symptom of rule.symptoms || []) {
      const gate = evaluateSafetyGate(caseFor(`${symptom}3天`, rule.id === "pediatric_critical"));
      if (outletCount(gate) === 0) silent.push(`${rule.id}::${symptom}`);
    }
  }
  const unexplained = silent.filter((key) => !BARE_EXEMPT.has(key));
  assert.deepEqual(
    unexplained, [],
    `以下受治理症状词单独写进病历时三个出口全静默，且无豁免理由：\n  ${unexplained.join("\n  ")}\n`
    + "「休克」「脓毒症」「高渗状态」这类**诊断级结论词**写进病历时本身就是结论，"
    + "不应再要求叠加限定词；「喉头水肿 vs 喉头肿胀」「阴道出血 vs 阴道流血」这类一字之差"
    + "则是行内字面量与受治理表分叉的典型形态。若确属有意，请连同理由写进 BARE_EXEMPT。",
  );
  for (const [key, why] of BARE_EXEMPT) {
    assert.ok(
      silent.includes(key),
      `豁免项「${key}」现在已可达（原豁免理由：${why}）。豁免已过期，请删除它——`
      + "留着过期豁免会掩盖将来真正的回退。",
    );
  }
}

// ── 3. 收敛不得制造误报：良性门诊主诉零提示 ────────────────────────────────
{
  const BENIGN = [
    "反复胃脘胀痛3月，纳差", "月经量少3月，色淡", "失眠多梦半年，易醒",
    "咳嗽咳白痰1周，无发热", "腰膝酸软2年，畏寒", "口干口苦1周",
    "大便溏薄3月，日2-3次", "颈项僵痛1月，久坐加重", "湿疹瘙痒2周",
    "乏力气短3月，动则汗出",
  ];
  for (const complaint of BENIGN) {
    const advisories = narrativeFallbackAdvisories(caseFor(complaint));
    assert.deepEqual(
      advisories, [],
      `良性门诊主诉不得产生急症提示：「${complaint}」实得 ${advisories.length} 条。`
      + "把受治理表整表并进提示档时最容易在这里翻车。",
    );
  }
}

// ── 4. 否定式静默 + 去掉否定必须报（反证；防止上一条是空转）────────────────
// 「零误报」若来自「这些词压根匹配不到」，它证明不了否定处理在工作。必须成对断言。
{
  const PAIRS = [
    ["头晕1周，血压正常，无休克表现", "头晕1周，出现休克表现"],
    ["皮疹1周，无喉头肿胀呼吸困难", "皮疹1周，喉头水肿伴喘鸣"],
    ["腹痛2天，否认阴道流血，月经规律", "妊娠12周，孕期阴道出血2天"],
    ["乏力1月，否认低血糖发作", "乏力1月，血糖高渗状态"],
    ["胃脘痛3天，否认呕血黑便", "胃脘痛3天，呕血1次"],
  ];
  for (const [negated, positive] of PAIRS) {
    assert.equal(
      narrativeFallbackAdvisories(caseFor(negated)).length, 0,
      `否定式表述不得触发提示：「${negated}」`,
    );
    assert.ok(
      narrativeFallbackAdvisories(caseFor(positive)).length > 0,
      `阳性对照必须触发提示：「${positive}」——这里若为 0，上一条的「零误报」是空转而非防线`,
    );
  }
}

// ── 5. 产科二分不得退化成整表并入 ──────────────────────────────────────────
// obstetric.symptoms 里「妊娠出血」「孕期阴道出血」自带妊娠限定可独立成立；
// 「剧烈下腹痛」不带——整表并入的后果很具体：非孕患者的剧烈下腹痛被判成产科急症。
{
  const nonPregnant = narrativeFallbackAdvisories(caseFor("剧烈下腹痛2天，已绝经5年"));
  assert.ok(
    !nonPregnant.some((line) => line.includes("产科")),
    `非孕患者的剧烈下腹痛不得判为产科急症（它由 acute_abdomen 承接）。实得：${nonPregnant.join(" | ")}`,
  );
  const pregnant = narrativeFallbackAdvisories(caseFor("妊娠20周，剧烈下腹痛2天"));
  assert.ok(
    pregnant.some((line) => line.includes("产科")),
    `妊娠合并剧烈下腹痛必须判为产科急症。实得：${pregnant.join(" | ")}`,
  );
}

// ── 6. 测量档类目用真实体征验证（上面按名字豁免了它们，这里补上真正的检查）──
{
  const CRITICAL = [
    ["危急血压", "BP 70/40mmHg"],
    ["极端体温", "T 41.2℃"],
    ["严重心率异常", "P 155次/分"],
    ["严重呼吸频率异常", "R 38次/分"],
    ["低血氧", "SpO2 84%"],
  ];
  for (const [label, vitals] of CRITICAL) {
    const gate = evaluateSafetyGate(caseFor("乏力3天", false, vitals));
    assert.ok(
      (gate.redFlags || []).length > 0,
      `受治理 vital_instability「${label}」必须由实测体征触发红旗：「${vitals}」实得 0 条。`
      + "这一类的检出走生命体征解析而非文本，是确定性安全层的地板。",
    );
  }
  // 正常体征必须零红旗——否则上面五条是「恒报」而不是「按阈值报」
  const normal = evaluateSafetyGate(
    caseFor("乏力3天", false, "T 36.6℃ P 78次/分 R 18次/分 BP 120/76mmHg SpO2 98%"));
  assert.equal(
    (normal.redFlags || []).length, 0,
    `全部正常的生命体征不得触发红旗，实得 ${(normal.redFlags || []).length} 条——`
    + "若这里非零，上面五条阈值断言是恒真的空转。",
  );
}

console.log("test-governed-redflag-vocabulary-reachability: OK", {
  textCategories: textCategories.length,
  symptoms: totalSymptoms,
  bareExempt: BARE_EXEMPT.size,
});
