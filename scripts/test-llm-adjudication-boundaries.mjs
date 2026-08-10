/**
 * 把判断交回模型 + 确定性层只做校验：两处接入点的安全边界。
 *
 * 【为什么要交回去】本系统是 LLM 驱动的临床副驾驶，不是规则推理引擎。实测两处被规则架空：
 *  ① 极性层：中医里「无汗」「不渴」「不恶寒」是证候的**定义性指征**，不是「没有该症状」。
 *     风寒表实的教科书主诉「恶寒发热，无汗，头痛，身痛，脉浮紧」，召回侧只拿到 3 条事实——
 *     无汗被当否定剥掉，头痛/身痛被它的作用域顺着逗号带走。而「无汗」恰是表实证区别于
 *     桂枝汤证的眼目。规则层区分不了「四诊指征」与「系统回顾式否认」，这是模型的活。
 *  ② 方义：applyDeterministicHerbFunctions 无条件覆盖模型写的 function，而兜底句永远非空，
 *     于是模型的方义 100% 被丢弃。当前代码在 7461 条归档药味行上重放：35.4%（2638 条）
 *     最终印的是「君药，本方中的具体配伍作用需医生结合方义复核」这句零内容套话，
 *     而这 2638 条里 KB 本就没有功效条目的是 **0 条**——全是「库里有、2-gram 对不上治法」。
 *
 * 【交回去的前提，就是本套件钉的东西】
 *  · 阳性方向关在受治理闭集里（68 词），候选生成与结果采纳**各校验一次**；
 *  · 模型只能返回候选序号，无法引入任何新文本；
 *  · 审方/方剂禁忌用的 affirmed_or_uncertain scope **完全忽略**阳性增补——
 *    那一侧故意保留未消解表述以免漏警告，在那里把否定改成阳性等于凭空造出用药依据；
 *  · 方义保留模型文本的前提是过 herbFunctionMatchesKnowledge（与合同侧
 *    candidate_*_herb_*_function_ungrounded 同一个导出谓词），高影响方向必须有 KB 佐证；
 *  · 模型不可用/超时/解析失败一律回落到今天的确定性行为。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true, interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { affirmativeNegationCandidates, colloquialNegationCandidates } =
  await jiti.import("../src/lib/polarity-negation-assist.server.ts");
const { affirmedClinicalText } = await jiti.import("../src/lib/clinical-polarity.ts");
const { positiveCaseFacts } = await jiti.import("../src/lib/tcm-formula-indications.ts");
const { affirmativeNegationFormsIn, affirmativeNegationFormCount } =
  await jiti.import("../src/lib/clinical-vocabulary.ts");
const { applyDeterministicHerbFunctions } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

let checks = 0;
const failures = [];
const ok = (label, condition) => { checks += 1; if (!condition) failures.push(label); };

const caseOf = (chiefComplaint) => ({
  patient: { sex: "男", age: 35 }, chiefComplaint, symptoms: {},
  tongue: "苔薄白", pulse: "脉浮紧", faceNote: "", conversation: [], vitals: {}, history: {},
});
const MAHUANG = "恶寒发热，无汗，头痛，身痛，脉浮紧";
const REVIEW_OF_SYSTEMS = "既往体健，无汗出、无心悸、无胸闷";

// ── ① 阳性方向的闭集门 ────────────────────────────────────────────────────
ok("受治理词表非空（闭集是这一侧唯一的安全阀）", affirmativeNegationFormCount() >= 60);
{
  const candidates = affirmativeNegationCandidates(caseOf(MAHUANG));
  ok("表实主诉的「无汗」进入候选", candidates.includes("无汗"));
  ok("候选全部含受治理词",
    candidates.every((clause) => affirmativeNegationFormsIn(clause).length > 0));
}
// 闭集外的否认**永远不进候选**：模型没有机会把它读成阳性。
for (const text of ["否认胸痛，否认气促", "无胸闷", "否认口渴、多饮、多尿", "无外伤"]) {
  const candidates = affirmativeNegationCandidates(caseOf(text));
  ok(`闭集外否认不进阳性候选：${text}`,
    candidates.every((clause) => affirmativeNegationFormsIn(clause).length > 0));
}
// 确定性层判阳性的分句不进阳性候选（本来就没丢，不需要救）。
ok("已判阳性的分句不进阳性候选", affirmativeNegationCandidates(caseOf("头痛，身痛")).length === 0);
// 否定方向的候选池不受影响。
ok("否定方向候选仍工作", Array.isArray(colloquialNegationCandidates(caseOf("胸口不疼，早就不疼了"))));

// ── ② 裁决生效后的召回事实 ────────────────────────────────────────────────
{
  const none = { negated: new Set(), affirmed: new Set() };
  const affirmedWuhan = { negated: new Set(), affirmed: new Set(["无汗"]) };
  const before = positiveCaseFacts(caseOf(MAHUANG));
  const after = positiveCaseFacts(caseOf(MAHUANG), affirmedWuhan);
  ok(`裁决前主诉事实丢失（实测基线，${before.length} 条）`, !before.join("；").includes("无汗"));
  ok("裁决后「无汗」回到阳性事实", after.join("；").includes("无汗"));
  // 一处裁决同时修好被带走的下文：头痛/身痛本是被「无汗」的作用域顺着逗号吃掉的。
  ok("裁决后「头痛」不再被作用域带走", after.join("；").includes("头痛"));
  ok("裁决后「身痛」不再被作用域带走", after.join("；").includes("身痛"));
  // 空裁决 = 今天的行为，逐字不变。
  ok("空裁决等于今天的确定性行为",
    positiveCaseFacts(caseOf(MAHUANG), none).join("；") === before.join("；"));
  ok("系统回顾式否认在空裁决下不变",
    !positiveCaseFacts(caseOf(REVIEW_OF_SYSTEMS), none).join("；").includes("无汗出"));
}

// ── ③ scope 边界：审方/禁忌侧必须完全忽略阳性增补 ────────────────────────
{
  const affirmedWuhan = { negated: new Set(), affirmed: new Set(["无汗"]) };
  const evidence = affirmedClinicalText(MAHUANG, "affirmed", affirmedWuhan) || "";
  const audit = affirmedClinicalText(MAHUANG, "affirmed_or_uncertain", affirmedWuhan) || "";
  ok("证据类 scope 采纳阳性增补", evidence.includes("无汗"));
  ok("审方类 scope 完全忽略阳性增补", !audit.includes("无汗"));
  ok("审方类 scope 与无增补时逐字相同",
    audit === (affirmedClinicalText(MAHUANG, "affirmed_or_uncertain") || ""));
}
// 旧形态（单个 Set）必须仍然只作用于否定方向，不得被误读成阳性集合。
{
  const legacy = new Set(["胸口不疼"]);
  const text = "胸口不疼，头痛明显";
  ok("旧形态 Set 仍按否定方向解释",
    !(affirmedClinicalText(text, "affirmed", legacy) || "").includes("胸口不疼"));
}

// ── ④ 方义：校验而非覆盖 ──────────────────────────────────────────────────
const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const prescribeWith = (fn) => `前言\n${START}\n${JSON.stringify({
  stage: "prescribe",
  therapy: { overallMethod: "燥湿化痰，理气和中" },
  formula: { candidates: [{ name: "二陈汤", therapyMatch: "燥湿化痰", herbs: [
    { name: "茯苓", role: "臣", targetPathogenesis: "痰湿中阻", function: fn },
  ] }] },
})}\n${END}\n后语`;
const functionAfter = (fn) => {
  const out = applyDeterministicHerbFunctions(prescribeWith(fn));
  const parsed = JSON.parse(out.slice(out.indexOf(START) + START.length, out.indexOf(END)).trim());
  return String(parsed.formula.candidates[0].herbs[0].function || "");
};
const BOILERPLATE = /^(?:君|臣|佐|使|配伍)药，.*需医生结合方义复核$/;
ok("模型写的、能接地的方义被保留", functionAfter("健脾渗湿，杜生痰之源") === "健脾渗湿，杜生痰之源");
ok("模型留空时回落服务端文本", BOILERPLATE.test(functionAfter("")));
// 高影响方向必须有该药 KB 佐证——茯苓不收载清热活血。
ok("编造高影响方向被驳回并回落", BOILERPLATE.test(functionAfter("清热活血，破血逐瘀")));
ok("营销词被驳回并回落", BOILERPLATE.test(functionAfter("美容养颜，延年益寿")));
// 提示词必须真的向模型要这个字段——否则「交回模型」只是空话。
{
  const prompts = await import("node:fs").then((fs) =>
    fs.readFileSync(path.join(repoRoot, "src/lib/diagnosis-prompts.ts"), "utf8"));
  ok("M04 JSON 模板含 function 字段", /"function":"该药在本方中承担的具体作用"/.test(prompts));
  ok("提示词说明 function 写本方作用而非罗列全部功效", /不是罗列它的全部功效/.test(prompts));
}

// ── ⑤ 剥名透明度：医生必须看得到「系统原本锁的是什么」 ──────────────────────
// 归档实测：M03 页写「推荐方：麻黄汤」，M04 页给一张不含麻黄的自拟方，
// 身份说明只写「未沿用原命名经方身份」——两页互相矛盾，医生无从判断是换了方向
// 还是组成没对上。剥名判定本身不变，补的是系统已经知道却没说的那半句。
{
  const { synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const payload = (from) => `${START}\n${JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    formula: { candidates: [{
      name: "本例辨证组方加减", constructionType: "self_devised",
      identityDeclassified: true,
      identityDeclassificationReason: "classic_composition_unverified_after_repair",
      ...(from ? { declassifiedFromFormulaNames: from } : {}),
      therapyMatch: "辛温解表",
      herbs: [{ name: "荆芥", role: "君", dose: "10g", prescriptionRole: "君药",
        targetPathogenesis: "风寒袭表", function: "解表散风" }],
      decoction: { doseCount: "3剂", dosesPerDay: 1, administrationTimesPerDay: 2 },
    }] },
  })}\n${END}`;
  const withName = synchronizeVisibleClinicalSummary(payload(["麻黄汤"]), "prescribe");
  const without = synchronizeVisibleClinicalSummary(payload(null), "prescribe");
  ok("渲染确实产出了 M04 正文（否则下面两条断言无意义）", withName.includes("候选方药"));
  ok("剥名时说出 M03 原锁定的方名", withName.includes("麻黄汤"));
  ok("剥名说明仍保留「不代表原方或经典出处」", withName.includes("不代表原方或经典出处"));
  ok("无原方名记录时回落到原有措辞", without.includes("实际组成未沿用原命名经方身份"));
  ok("无原方名记录时不得凭空捏造方名", !without.includes("原锁定"));

  // 候选自身没有任何可记录的方名时（模型自己就写成「本例辨证组方」且 formulaNames 为空，
  // 这是线上实测的真实形态），必须从 M03 签名结论兜底取锁定方名——否则两页依旧互相矛盾。
  const { markTransparentFormulaDeclassification } = await jiti.import("../src/lib/diagnosis-api.ts");
  const bare = `${START}\n${JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{
      name: "本例辨证组方", constructionType: "self_devised", formulaNames: [],
      herbs: [{ name: "荆芥" }, { name: "防风" }, { name: "羌活" }],
    }] },
  })}\n${END}`;
  const prior = { overview: { recommendedFormulaNames: ["麻黄汤"] } };
  const marked = markTransparentFormulaDeclassification(bare, prior);
  ok("候选无方名时从 M03 结论兜底取锁定方名", marked.includes("麻黄汤"));
  const noPrior = markTransparentFormulaDeclassification(bare, null);
  ok("M03 也没有锁定方名时不得凭空捏造", !noPrior.includes("麻黄汤"));
}

// ── ⑥ 规则不得连坐作废模型的整批输出（M02 追问计划）────────────────────────
// M02 一轮只问 1–2 题，而 parseM02Plan 的循环里到处 `return null`，那是**整份计划**的 null：
// 第二题任何一处不合格（哪怕只是命中「姓名/天气/身份证」这类低价值词表），
// 医生就一道追问都拿不到。这是本仓库复发第 7 次的同一形状——单条非法连坐整批。
{
  const { parseM02Plan } = await jiti.import("../src/lib/m02-question-contract.ts");
  const q = (id, question) => ({
    id, question, reason: "决定湿浊来源判断方向", targetField: "xianbingshi",
    decisionBranch: "syndrome", expectedDecisionImpact: "决定是否从脾胃论治",
    informationGain: 0.86, sourceEvidence: ["嘴里发黏"],
    options: [
      { id: `${id}-a`, label: "进食后加重", answer: "进食后口中黏腻明显加重", kind: "clinical_fact", recordValue: "进食后口中黏腻明显加重" },
      { id: `${id}-b`, label: "无明显关系", answer: "与进食无明显关系", kind: "clinical_fact", recordValue: "口中黏腻与进食无明显关系" },
      { id: `${id}-u`, label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
    ],
  });
  const plan = (qs) => ({
    schemaVersion: "tcm-cdss-m02-plan-v1", decision: "ask",
    rationale: "仍有可改变处置的未决问题", questions: qs,
  });
  const both = parseM02Plan(structuredClone(plan([q("q1", "口中黏腻与进食有无明显关系？"), q("q2", "大便是否黏滞不爽？")])));
  ok("两题都合格时保留两题", both?.questions.length === 2);
  const oneBadWord = parseM02Plan(structuredClone(plan([q("q1", "口中黏腻与进食有无明显关系？"), q("q2", "请问您的身份证号是多少？")])));
  ok("第二题命中低价值词表时**只丢它**，不连坐", oneBadWord?.questions.length === 1);
  ok("保留下来的是合格那一题", oneBadWord?.questions[0]?.question.includes("口中黏腻"));
  const oneBadShape = parseM02Plan(structuredClone(plan([
    q("q1", "口中黏腻与进食有无明显关系？"),
    { ...q("q2", "大便是否黏滞？"), options: [{ id: "x", label: "A", answer: "是", kind: "clinical_fact", recordValue: "是" }] },
  ])));
  ok("第二题结构非法时同样只丢它", oneBadShape?.questions.length === 1);
  // 反向：一条都不剩时计划仍不可用——这不是放宽，与今天行为一致。
  const allBad = parseM02Plan(structuredClone(plan([q("q1", "请问天气如何？"), q("q2", "您的手机号？")])));
  ok("全部不合格时整份计划仍判空", allBad === null);
}

// ── ⑦ 症状级主诊断规范化：不得把疾病实体降级、不得按表行序抢主症 ────────────
// 实测（2026-08-10）三个独立缺陷叠在一起：
//  A 取值用 governedSymptomLabels.find()，即**表行序**首个命中——腹泻在第 2 行、头痛在第 11 行，
//    于是「主诉：头痛3天，伴恶心、大便稀」的主诊断被算成「腹泻症状」，
//    而 supportingFacts 仍是「头痛3天」：一张自相矛盾的诊断卡，错名还带 ICD 编码进 HIS。
//  B 「是不是症状级」只看末两字，于是「偏头痛」(ICD G43)、「良性阵发性位置性眩晕」(BPPV) 被降级。
//  C 改写后原标签**凭空消失**——不进鉴别、不写理由，与合法降级通路的做法相反。
// 且 prepare 每轮修复都重跑，模型改回去还会被改一次，模型赢不了。
{
  const { normalizeDiagnoseConfidenceAndLabels } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const payload = (name, facts) => `${START}\n${JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    westernDiagnosis: {
      primary: { name, status: "工作诊断", confidence: "中", supportingFacts: facts, clinicalRationale: "依据主诉" },
      differentials: [],
    },
  })}\n${END}`;
  const normalized = (name, facts, ctx) => {
    const out = normalizeDiagnoseConfidenceAndLabels(payload(name, facts), ctx);
    const parsed = JSON.parse(out.slice(out.indexOf(START) + START.length, out.indexOf(END)).trim());
    return {
      name: String(parsed.westernDiagnosis.primary.name || ""),
      differentials: (parsed.westernDiagnosis.differentials || []).length,
    };
  };
  // A：主症由**主诉语序**决定，兼症（伴/并/同时之后）不得抢主症。
  for (const [name, facts, ctx] of [
    ["头痛症状", ["头痛3天"], "主诉：头痛3天，伴恶心、大便稀。"],
    ["心悸症状", ["心悸1月"], "主诉：心悸1月，伴乏力便溏。"],
    ["头晕症状", ["头晕3天"], "主诉：头晕3天，近来咳嗽。"],
  ]) {
    ok(`兼症不得抢主症：${name} + ${ctx.slice(3, 12)}`, normalized(name, facts, ctx).name === name);
  }
  // B：疾病实体不得被当成症状级工作诊断降级。它们没有不确定性标记，模型给的是确诊名。
  for (const [name, facts, ctx] of [
    ["偏头痛", ["单侧搏动性头痛"], "主诉：反复发作性头痛3年。现病史：单侧搏动性头痛，伴畏光恶心"],
    ["良性阵发性位置性眩晕", ["Dix-Hallpike阳性"], "主诉：反复发作性眩晕2个月。现病史：起床翻身诱发"],
    ["慢性胃炎", ["上腹隐痛"], "主诉：上腹隐痛半年。"],
  ]) {
    ok(`疾病实体不得降级：${name}`, normalized(name, facts, ctx).name === name);
  }
  // 反向：正当的接地纠正必须仍然生效，且原标签必须进鉴别（不得凭空消失）。
  {
    const wheeze = normalized("劳力性呼吸困难待查", ["活动后气喘"], "主诉：活动后气喘。现病史：查体闻及喘鸣音");
    ok("病历记录喘鸣时仍纠正为喘息症状", wheeze.name === "喘息症状");
    ok("纠正时原标签进鉴别", wheeze.differentials >= 1);
    const constipation = normalized("腹胀症状", ["肚子胀"], "大便老解不出来，四五天一次，肚子还胀");
    ok("兼症标签仍被规范为主症（便秘）", constipation.name === "便秘症状");
    ok("规范时原标签进鉴别", constipation.differentials >= 1);
  }
}

if (failures.length > 0) {
  console.error("[test:llm-adjudication-boundaries] 失败项：");
  for (const item of failures) console.error("  - " + item);
}
assert.equal(failures.length, 0, `${failures.length}/${checks} 项失败`);
console.log(`[test:llm-adjudication-boundaries] OK — ${checks} 项断言全过`);
