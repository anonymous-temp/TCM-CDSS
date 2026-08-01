/**
 * Invariant: 追问是可选增强，不是流程闸门；每题都必须给医生一个「其他（请补充）」出口。
 *
 * 需求1 的两条：
 *
 * 1) 「追问不阻断流程」。M03 路由此前有一道门——completeness 未达 C 且 questionRounds < 1 时，
 *    直接返回降级的 needs_information 有限诊断，把医生赶回 M02。它是**流程门**不是安全控制：
 *    剂量级放行由 M04 独立把守（prescribe 路由自己检查 completeness 与 safetyGate），
 *    红旗由 withSafetyGate 独立判定。M03 提示词本身也写着「该等级只用于表达置信范围，
 *    不是流程门槛」——路由的这道门与提示词长期自相矛盾。已移除。
 *
 * 2) 「选项含其他，其他的话医生可以自己输入」。它与「本次未取得」不是一回事：
 *      unknown = 本次没取得这条信息，不写入病历；
 *      other   = 问到了，但答案不在两个预设分支里，医生自己写，写入病历。
 *    混用会把「问到了但答案不在选项里」记成「没问到」——那是一条被丢掉的患者事实。
 *
 * 加「其他」时踩到的坑值得记住：整条 M02 选项管线原本硬编码为恰好 3 个（A/B/C），
 * 输入校验、Markdown 标签校验、Markdown 反解析三处各有一个 `length !== 3`。
 * 计划会经历「结构化 → Markdown → 反解析」的往返，追加第 4 项后往返回来的那一份整份判空，
 * 表现为问题卡直接消失。因此本文件同时锁住「往返幂等」这条性质。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCaseAwareQuestionFallback,
  ensureQuestionStructuredEnvelope,
  parseM02Plan,
  parseM02PlanFromContent,
} from "../src/lib/m02-question-contract.ts";

// ── 1) 追问不再阻断 M03 ───────────────────────────────────────────────────────
const diagnoseRoute = readFileSync(new URL("../src/app/api/diagnosis/diagnose/route.ts", import.meta.url), "utf8");
assert.doesNotMatch(
  diagnoseRoute,
  /completeness\.level !== "C" && \w*\.?questionRounds < 1/,
  "M03 不得因为「还没做过追问」而拒绝出结果——追问是可选增强，不是流程闸门",
);
assert.match(
  diagnoseRoute,
  /追问不阻断流程/,
  "移除该门的理由必须留在代码里，否则下一个人会把它加回来",
);
// 剂量级安全线仍必须由 M04 独立把守——这是上面那道门可以安全移除的前提。
const prescribeRoute = readFileSync(new URL("../src/app/api/diagnosis/prescribe/route.ts", import.meta.url), "utf8");
assert.match(
  prescribeRoute,
  /completeness\.level !== "C"/,
  "M04 必须独立检查完整度：它才是剂量级放行的把关处",
);

// ── 2) 每题都有「其他（请补充）」 ────────────────────────────────────────────
const modelPlan = {
  schemaVersion: "tcm-cdss-m02-plan-v1",
  decision: "ask",
  rationale: "仍有可改变处置的未决问题",
  questions: [{
    id: "q1",
    question: "口中黏腻与进食有无明显关系？",
    reason: "决定湿浊来源判断方向",
    targetField: "xianbingshi",
    decisionBranch: "syndrome",
    expectedDecisionImpact: "决定是否从脾胃论治",
    informationGain: 0.86,
    sourceEvidence: ["嘴里发黏"],
    options: [
      { id: "after-meal", label: "进食后加重", answer: "进食后口中黏腻明显加重", kind: "clinical_fact", recordValue: "进食后口中黏腻明显加重" },
      { id: "no-relation", label: "无明显关系", answer: "与进食无明显关系", kind: "clinical_fact", recordValue: "口中黏腻与进食无明显关系" },
      { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
    ],
  }],
};

const parsed = parseM02Plan(structuredClone(modelPlan));
assert.ok(parsed, "模型给出的三选项计划必须能被解析");
const parsedOptions = parsed.questions[0].options;
assert.deepEqual(
  parsedOptions.map((option) => option.kind),
  ["clinical_fact", "clinical_fact", "other", "unknown"],
  "服务端必须确定性追加「其他」，并插在「本次未取得」之前",
);
const otherOption = parsedOptions.find((option) => option.kind === "other");
assert.ok(otherOption, "每题必须有「其他」出口");
assert.equal(otherOption.requiresDetail, true, "「其他」必须要求医生自己填写具体内容");
assert.equal(otherOption.recordValue, undefined, "「其他」不得携带预置回填值——内容由医生提供");
assert.notEqual(otherOption.kind, "unknown", "「其他」不能与「本次未取得」混为一谈：前者写入病历，后者不写");

// 幂等：已经带「其他」的计划再解析一次不得重复追加。
const reparsed = parseM02Plan(structuredClone(parsed));
assert.equal(
  reparsed?.questions[0].options.filter((option) => option.kind === "other").length,
  1,
  "重复解析不得叠加出多个「其他」",
);

// 往返：结构化 → Markdown 信封 → 反解析，必须仍是同一份计划。
const envelope = ensureQuestionStructuredEnvelope(
  `**问题1：** 口中黏腻与进食有无明显关系？\n\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ completeness: { level: "B" }, m02Plan: modelPlan })}\n<!-- DIAGNOSIS_JSON_END -->`,
  "这阵子嘴里发黏，到了下午脑袋发沉",
);
const roundTripped = parseM02PlanFromContent(envelope);
assert.ok(roundTripped, "带「其他」的计划经 Markdown 往返后不得整份判空——那会让问题卡直接消失");
assert.equal(roundTripped.questions[0].targetField, "xianbingshi");
assert.equal(
  roundTripped.questions[0].options.filter((option) => option.kind === "other").length,
  1,
  "往返后「其他」必须仍在且只有一个",
);

// 兜底路径（模型不可用时）同样要有「其他」。
const fallback = buildCaseAwareQuestionFallback({
  patient: { age: 46 },
  chiefComplaint: "反复入睡困难3月余",
  symptoms: { presentHistory: "入睡困难，多梦易醒" },
});
const fallbackPlan = parseM02PlanFromContent(ensureQuestionStructuredEnvelope(fallback, "", fallback));
assert.ok(fallbackPlan?.questions.length, "兜底路径必须也产出结构化问题");
for (const question of fallbackPlan.questions) {
  assert.equal(
    question.options.filter((option) => option.kind === "other").length,
    1,
    `兜底问题「${question.question.slice(0, 16)}…」也必须给医生「其他」出口`,
  );
}

// ── 3) 问题必须带导向与依据（需求1 的"有价值和信息度"）────────────────────────
for (const question of [...parsed.questions, ...fallbackPlan.questions]) {
  assert.ok(
    ["triage", "differential", "syndrome", "treatment_safety"].includes(question.decisionBranch),
    "每题必须声明它服务于哪个决策方向：红旗排查/鉴别诊断/证候辨析/治疗安全",
  );
  assert.ok(question.reason && question.reason.length >= 8, "每题必须给出追问依据，而不是只抛一个问题");
  assert.ok(question.expectedDecisionImpact, "每题必须说明不同回答会改变哪项临床判断");
}

console.log(JSON.stringify({
  suite: "m02-nonblocking",
  modelQuestionOptions: parsedOptions.length,
  fallbackQuestions: fallbackPlan.questions.length,
  failures: 0,
}, null, 2));
