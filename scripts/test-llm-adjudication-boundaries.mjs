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
import { readFileSync } from "node:fs";
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

// M05 的患者级撰写必须只有一个入口，三个出口都消费它；安全 verdict 仍由各路由随后调用
// buildDeterministicRiskFollowup(Payload) 合并，不能进入模型作者的返回合同。
{
  const authoringSource = readFileSync(path.join(repoRoot, "src/lib/m05-followup-authoring.server.ts"), "utf8");
  assert.match(authoringSource, /export async function authorFollowupForCase\(/, "缺少三出口共享的 M05 患者级撰写入口");
  assert.doesNotMatch(authoringSource.slice(authoringSource.indexOf("export type AuthoredFollowupContent"), authoringSource.indexOf("};", authoringSource.indexOf("export type AuthoredFollowupContent")) + 2), /auditResult|highestRiskLevel|safetyLocked|riskVerdict/, "模型撰写合同不得包含确定性风险 verdict");
  for (const route of ["assess", "post-prescription-risk", "his-scheme"]) {
    const source = readFileSync(path.join(repoRoot, `src/app/api/diagnosis/${route}/route.ts`), "utf8");
    assert.match(source, /authorFollowupForCase/, `${route} 未消费共享 M05 患者级撰写入口`);
  }
  const hisSource = readFileSync(path.join(repoRoot, "src/app/api/diagnosis/his-scheme/route.ts"), "utf8");
  assert.ok((hisSource.match(/authorFollowupForCase\(/g) || []).length >= 2, "HIS 的审方成功与不可用分支都必须生成患者级随访");
}
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
const functionAfter = (fn, opts) => {
  const out = applyDeterministicHerbFunctions(prescribeWith(fn), opts);
  const parsed = JSON.parse(out.slice(out.indexOf(START) + START.length, out.indexOf(END)).trim());
  return String(parsed.formula.candidates[0].herbs[0].function || "");
};
const BOILERPLATE = /^(?:君|臣|佐|使|配伍)药，.*需医生结合方义复核$/;
ok("模型写的、能接地的方义被保留", functionAfter("健脾渗湿，杜生痰之源") === "健脾渗湿，杜生痰之源");
// ── 甲方 2026-08-10 ⑤：兜底分两段 ──────────────────────────────────────────────
// 服务端此前在**契约校验之前**就把角色兜底句写进 function，而契约又显式放行该句，
// 于是 candidate_*_herb_*_function(_ungrounded) 永不触发、那轮修复指导语成了死代码，
// 医生看到的就是「臣药，本方中的具体配伍作用需医生结合方义复核」这句零内容套话。
ok("契约前留空不被兜底句顶上（否则修复轮永远不会被唤起）", functionAfter("") === "");
ok("finalize（修复耗尽）才补兜底句，医生不会看到空栏", BOILERPLATE.test(functionAfter("", { fillRolePlaceholder: true })));
// 高影响方向必须有该药 KB 佐证——茯苓不收载清热活血。契约前保留原文以便修复轮定位，
// 但它绝不能活到医生面前：finalize 一定把它换成 KB 对齐串或兜底句。
ok("编造高影响方向不得活过 finalize", (() => {
  const finalized = functionAfter("清热活血，破血逐瘀", { fillRolePlaceholder: true });
  return !/清热活血|破血逐瘀/.test(finalized);
})());
ok("营销词不得活过 finalize", (() => {
  const finalized = functionAfter("美容养颜，延年益寿", { fillRolePlaceholder: true });
  return !/美容养颜|延年益寿/.test(finalized);
})());
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

// ── ⑧ 「病历已回答过」不得主语盲、极性盲 ──────────────────────────────────
// optionAlreadyKnown 原来是整份病历的纯逐字包含，两类相反事实被当成同一件（2026-08-10 实测）：
//  · 家族史「患者母亲有糖尿病」让「患者**本人**是否诊断过糖尿病」被删；
//  · 「否认胸痛」让「近一周静息时是否出现过胸痛」被删，理由还写「答案已在病历中明确记录」。
// 顺带查出极性层的一个缺口：字段标签会挡住否定判定——
// affirmedClinicalText("现病史：否认胸痛") 原样保留该句，因为「否认」不在分句起始。
{
  const { enforceM02UnansweredAxes, ensureQuestionStructuredEnvelope } =
    await jiti.import("../src/lib/m02-question-contract.ts");
  const question = (label, recordValue, text) => ({
    id: "q1", question: text, reason: "决定鉴别方向", targetField: "xianbingshi",
    decisionBranch: "syndrome", expectedDecisionImpact: "决定是否按此方向处置",
    informationGain: 0.8, sourceEvidence: [],
    options: [
      { id: "a", label, answer: label, kind: "clinical_fact", recordValue },
      { id: "b", label: "否", answer: "无此表现", kind: "clinical_fact", recordValue: "无此表现" },
      { id: "u", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
    ],
  });
  const keptCount = (source, q) => {
    const envelope = ensureQuestionStructuredEnvelope(JSON.stringify({
      completeness: { level: "B" },
      m02Plan: { schemaVersion: "tcm-cdss-m02-plan-v1", decision: "ask", rationale: "仍有未决问题", questions: [q] },
    }), source);
    return enforceM02UnansweredAxes(envelope, source).includes('"decision":"proceed"') ? 0 : 1;
  };
  const diabetes = question("糖尿病", "患者本人既往有2型糖尿病病史", "患者本人既往是否诊断过糖尿病？");
  ok("家族史不得让本人病史题被删",
    keptCount("反复口干乏力两月\n家族史：患者母亲有糖尿病。", diabetes) === 1);
  ok("本人确诊时该题仍应被删（反向不得放宽）",
    keptCount("反复口干乏力两月\n既往史：患者有糖尿病10年。", diabetes) === 0);
  ok("病历里的否认不得让新发症状题被删",
    keptCount("上腹隐痛一周\n现病史：否认胸痛、无黑便。",
      question("胸痛", "近一周静息胸痛向左肩放射", "近一周静息时是否出现过胸痛并向左肩放射？")) === 1);
}

// ── ⑨ 轴向「已回答」只能看本次病程，不能拿既往史/家族史抵账 ────────────────
// 原实现拿整份病历与问题做 5 个轴的笛卡尔 some()，两组正则之间没有任何症状/部位/时间尺度的
// 共同锚点。实测（2026-08-10）：「既往史：高血压病史10年」的时长词压掉「每次眩晕持续多久」；
// 「既往有胃部隐痛史」的隐痛压掉「本次胸闷程度」。既往史是另一个时间轴，抵不了本次病程。
{
  const { enforceM02UnansweredAxes, ensureQuestionStructuredEnvelope } =
    await jiti.import("../src/lib/m02-question-contract.ts");
  const durationQuestion = (text) => ({
    id: "q1", question: text, reason: "决定处置方向", targetField: "xianbingshi",
    decisionBranch: "syndrome", expectedDecisionImpact: "决定是否按此方向处置",
    informationGain: 0.8, sourceEvidence: [],
    options: [
      { id: "a", label: "数分钟", answer: "每次持续数分钟", kind: "clinical_fact", recordValue: "每次持续数分钟" },
      { id: "b", label: "数小时", answer: "每次持续数小时", kind: "clinical_fact", recordValue: "每次持续数小时" },
      { id: "u", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
    ],
  });
  const kept = (source, text) => {
    const envelope = ensureQuestionStructuredEnvelope(JSON.stringify({
      completeness: { level: "B" },
      m02Plan: { schemaVersion: "tcm-cdss-m02-plan-v1", decision: "ask", rationale: "仍有未决问题", questions: [durationQuestion(text)] },
    }), source);
    return enforceM02UnansweredAxes(envelope, source).includes('"decision":"proceed"') ? 0 : 1;
  };
  ok("既往史里的时长不得抵掉本次发作时长题",
    kept("反复头晕\n近来反复发作头晕，天旋地转感\n既往史：高血压病史10年",
      "每次眩晕大约持续多久？是数秒、数分钟还是数小时？") === 1);
  ok("行内「既往有…」同样不得抵账",
    kept("胸闷\n活动后胸闷，既往有胃部隐痛史", "本次胸闷发作时程度如何？是轻、中还是重？") === 1);
  ok("本次病程确已记录时仍应删（反向不得放宽）",
    kept("头晕\n每次眩晕持续约十分钟，反复发作两周",
      "每次眩晕大约持续多久？是数秒、数分钟还是数小时？") === 0);
}

// ── ⑥ M05 随访时间轴的「观察指标」也归模型，且必须能回落 ────────────────────
//
// 散文那一面（复诊评估重点/疗效评价标准/生活管理/六维裁剪）2026-08-10 已交给模型，
// 但随访时间轴那张表还是 coreFacts 拼串，传不传 authored **一字不差**。实测拼串形态
// （湿热下注/下尿路感染例）：
//   「下尿路感染；小便灼热涩痛5天；小便灼热；苔黄腻的严重程度、发作频次及对日常功能的影响」
// ——「下尿路感染」是诊断不是观察项，「苔黄腻」没有发作频次。
// 「本例复诊盯哪几个指标」与「复诊重点评估什么」是同一类判断，没理由一个交模型一个拼串。
{
  const { buildDeterministicRiskFollowupPayload } = await jiti.import("../src/lib/diagnosis-safety.ts");
  const state = {
    id: "m05-indicators", patient: { sex: "女", age: 34 }, chiefComplaint: "小便灼热涩痛5天",
    symptoms: {}, tongue: "苔黄腻", pulse: "脉滑数", conversation: [], vitals: {}, history: {},
    riskAssessment: "## 合理用药审方\n**审方结论**：未见确定性高危冲突。",
    reasoningDiagnose: {
      schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
      overview: { primarySyndrome: "湿热下注证", primarySyndromeBasis: ["小便灼热", "苔黄腻"] },
      westernDiagnosis: { primary: { name: "下尿路感染", status: "临床诊断", supportingFacts: ["下尿路感染", "小便灼热涩痛5天"] }, differentials: [] },
      pathogenesis: { chain: [] }, therapy: { overallMethod: "清热利湿通淋" },
    },
    reasoningPrescribe: {
      schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
      therapy: { overallMethod: "清热利湿通淋" }, nonPharma: { precautions: ["服药期间多饮温水"] },
      formula: { candidates: [{ name: "八正散加减", therapyMatch: "清热利湿通淋",
        herbs: [{ name: "车前子", dose: "15g", role: "君", prescriptionRole: "君药", targetPathogenesis: "湿热下注", function: "清热利湿通淋" }],
        decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2 } }] },
    },
  };
  const indicators = (authored) => buildDeterministicRiskFollowupPayload(state, authored)
    .timelineItems.map((item) => item.indicators.join("；"));
  const template = indicators(undefined);
  const authored = {
    reviewFocus: "重点复评尿频尿急尿痛的消长、小便颜色与灼热感、有无腰痛发热，舌苔由黄腻转薄白与否",
    efficacyCriteria: "排尿灼痛基本消失、小便转清、苔腻减退即为本轮有效",
    lifestyle: "忌辛辣肥甘与饮酒，多饮温水，勿憋尿，注意外阴清洁，避免久坐",
    dimensions: ["睡眠", "二便", "精神"],
    monitoringIndicators: ["排尿灼痛程度与次数", "小便颜色与浑浊度", "有无腰痛或发热", "舌苔黄腻消退情况"],
  };
  const withModel = indicators(authored);
  ok("模型给的观察指标进入随访时间轴", withModel.every((row) => row.includes("排尿灼痛程度与次数")));
  ok("诊断名不再被当成观察指标", withModel.every((row) => !row.includes("下尿路感染")));
  ok("舌苔不再被安上「发作频次」", withModel.every((row) => !/苔黄腻[^；]*发作频次/.test(row)));
  // 回落必须逐字等于今天的行为——这一层只增不减。
  ok("模型没给时逐字回落原拼串",
    indicators({ ...authored, monitoringIndicators: [] }).join("|") === template.join("|"));
  ok("authored 整体缺席时逐字回落原拼串", template.join("|") === indicators(null).join("|"));
  // 安全类固定行不得被模型的指标挤掉。
  ok("「实际用药与不适反应」始终保留", withModel[0].includes("实际用药与不适反应"));
  ok("「新发不适或原症加重」始终保留", withModel[1].includes("新发不适或原症加重"));
}

// ── ⑦ 煎法：准备指令不得给一味药挂上第二个投料时机 ────────────────────────
//
// 甲方实测：苦杏仁同时印出「后下」与「同煎」两条相反的煎法指令。根因是「捣碎」
// （准备）被**无条件**升级成「捣碎后同煎」（准备+时机），而时机位上已经有「后下」。
// 药典对生苦杏仁的要求是「捣碎、入煎剂后下」——捣碎是准备，后下是时机，本不冲突。
{
  const { decoctionRuleForHerb } = await jiti.import("../src/lib/herb-decoction-rules.ts");
  const rule = (name) => decoctionRuleForHerb(name) || { required: [], oneOf: [], prohibited: [] };
  const flat = (name) => [...rule(name).required, ...rule(name).oneOf.flat()].join("、");
  for (const name of ["苦杏仁", "燀苦杏仁", "杏仁"]) {
    ok(`${name} 保留「后下」`, rule(name).required.includes("后下"));
    ok(`${name} 不再同时要求同煎`, !flat(name).includes("同煎"));
    ok(`${name} 仍保留「捣碎」这条准备要求`, flat(name).includes("捣碎"));
  }
  // 反向：没有特定投料时机时，「同煎」仍要说出来（它是默认时机，但医生需要看到）。
  ok("无特定时机时仍写「捣碎后同煎」",
    ["决明子", "牛蒡子", "王不留行"].every((name) => {
      const text = flat(name);
      return !text || !text.includes("捣碎") || text.includes("捣碎后同煎") || /先煎|后下|另煎|另炖|烊化|冲服|兑服/.test(text);
    }));
  // 附子是这套规则里最要紧的一味：先煎**且**久煎（乌头碱水解），不是二选一。
  // 我在做上面那条修复时一度把它拆成 oneOf，这条断言就是为了不让那种事再发生。
  ok("附子必须同时要求先煎与久煎，不得降级为二选一",
    rule("附子").required.includes("先煎") && rule("附子").required.includes("久煎") &&
    !rule("附子").oneOf.some((alternatives) => alternatives.includes("先煎")));
}

// ── ⑧ 方解：模型写，服务端拼接只作兜底 ────────────────────────────────────
//
// 甲方实测两条症状：「方解仍是通用功效拼接」「桂枝出现占位复核话术」。根因是
// formulaAnalysis **100% 由服务端拼**（提示词里根本没这个字段），拼料是逐味 function，
// 而 function 取不到本方作用时会回落成「君药，本方中的具体配伍作用需医生结合方义复核」。
{
  const { applyDeterministicFormulaAnalysis } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const analysisAfter = (text) => {
    const payload = `${START}\n${JSON.stringify({
      schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
      therapy: { overallMethod: "辛温解表，宣肺平喘" },
      formula: { candidates: [{ name: "麻黄汤", therapyMatch: "辛温解表", formulaAnalysis: text,
        herbs: [
          { name: "麻黄", role: "君", dose: "9g", targetPathogenesis: "风寒束表", function: "发汗解表，宣肺平喘" },
          { name: "桂枝", role: "臣", dose: "6g", targetPathogenesis: "风寒束表", function: "君药，本方中的具体配伍作用需医生结合方义复核" },
          { name: "杏仁", role: "佐", dose: "9g", targetPathogenesis: "肺气上逆", function: "降利肺气" },
          { name: "甘草", role: "使", dose: "3g", targetPathogenesis: "调和诸药", function: "调和诸药" },
        ] }] },
    })}\n${END}`;
    const out = applyDeterministicFormulaAnalysis(payload);
    return String(JSON.parse(out.slice(out.indexOf(START) + START.length, out.indexOf(END)).trim())
      .formula.candidates[0].formulaAnalysis || "");
  };
  const GOOD = "本方以麻黄为君，开腠发汗、宣肺平喘，直解风寒束表之闭；桂枝为臣，助麻黄透营达卫、解肌发表，二药相须，发汗之力倍增。杏仁为佐，降利肺气，与麻黄一宣一降，复肺之开合。甘草为使，调和诸药并缓麻桂之峻，使汗出而不伤正。";
  ok("模型写的合格方解原样保留", analysisAfter(GOOD) === GOOD);
  ok("模型留空时回落到服务端拼接版", analysisAfter("").includes("麻黄"));
  ok("提到本方没有的药（石膏）被驳回",
    analysisAfter("本方以麻黄为君，桂枝为臣，另加石膏清泄郁热，共成辛凉之剂。") !== "本方以麻黄为君，桂枝为臣，另加石膏清泄郁热，共成辛凉之剂。");
  ok("方解里写剂量被驳回",
    analysisAfter("本方以麻黄9g为君发汗解表，桂枝6g为臣助其发表。").includes("麻黄为君"));
  ok("未点到本方药名的通用套话被驳回",
    analysisAfter("本方配伍严谨，君臣佐使分明，共奏其效，具体配伍作用需医生结合方义复核。").includes("麻黄为君"));
  // 提示词必须真的向模型要这个字段，否则「交回模型」又是空话。
  {
    const prompts = await import("node:fs").then((fs) =>
      fs.readFileSync(path.join(repoRoot, "src/lib/diagnosis-prompts.ts"), "utf8"));
    ok("M04 模板含 formulaAnalysis 字段", /"formulaAnalysis":/.test(prompts));
    ok("提示词说明方解不是逐味功效罗列", /不是逐味功效的罗列/.test(prompts));
  }
}

if (failures.length > 0) {
  console.error("[test:llm-adjudication-boundaries] 失败项：");
  for (const item of failures) console.error("  - " + item);
}
assert.equal(failures.length, 0, `${failures.length}/${checks} 项失败`);
console.log(`[test:llm-adjudication-boundaries] OK — ${checks} 项断言全过`);
