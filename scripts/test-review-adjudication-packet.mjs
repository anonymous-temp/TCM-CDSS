/**
 * P3/P4：争议裁决的最小载荷 + 结构化输出下的 max_tokens 策略。
 *
 * 钉住的生产事实（2026-08-29 token 审计）：
 *  · 裁决轮此前把**整份首轮提示词**重发给 qwen3.8-max（输入单价约为 flash 的 15 倍），
 *    而裁决器被明确要求「只裁决首轮指出的深度问题」。M03 实测 5/5 例触发裁决，
 *    每例 14.4k 输入；M04 的触发更窄但同样整份重发。
 *  · 百炼官方文档原文「开启结构化输出时，请勿设置 max_tokens」，而本仓三处结构化调用
 *    全都设着；修复轮的注释正好记录了它造成的「等-截断-重试循环」。
 *
 * 两条不变量必须同时成立：**载荷变小** 且 **未知问题码保守回落**——判据一旦放宽，
 * 行为要退化到今天的样子，而不是退化成信息不足的裁决。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildM03DiagnosticReviewPrompt,
  buildM03DiagnosticReviewAdjudicationPrompt,
  m03DiagnosticReviewNeedsAdjudication,
} from "../src/lib/m03-diagnostic-review.ts";
import {
  buildM04ClinicalReviewPrompt,
  buildM04ClinicalReviewAdjudicationPrompt,
  m04ClinicalReviewNeedsAdjudication,
} from "../src/lib/m04-clinical-review.ts";

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

const m03Reasoning = {
  overview: {
    tcmDiseaseName: "不寐", primarySyndrome: "心脾两虚证",
    overallPathogenesis: "心脾两虚，心神失养", overallTherapy: "补益心脾",
    tcmDiagnosticRationale: "四诊合参推理".repeat(60),
  },
  westernDiagnosis: {
    primary: {
      name: "失眠障碍", status: "考虑", supportingFacts: ["入睡困难3月"],
      clinicalRationale: "从事实到诊断倾向的推理".repeat(150),
      limitations: ["资料有限"], suggestedChecks: ["睡眠日记"],
    },
    differentials: Array.from({ length: 4 }, (_, i) => ({
      name: `鉴别${i}`, reason: "需要鉴别的理由".repeat(30),
      distinguishingPoints: "区分要点".repeat(30), nextCheck: "核实项",
    })),
    candidates: Array.from({ length: 3 }, (_, i) => ({
      name: `候选${i}`, likelihood: "中", keyEvidence: ["支持事实"], againstEvidence: [],
    })),
  },
  pathogenesis: {
    summary: "心神失养",
    chain: [{ nodeId: "P1", patientFact: "入睡困难3月", syndromeEvidence: "夜寐不安", pathogenesis: "心神失养", therapyDirection: "养心安神" }],
    uncertainties: [],
  },
  therapy: {
    overallPrinciple: "补益心脾", overallMethod: "养心安神",
    subTherapies: [{ therapy: "养心安神", targetPathogenesis: "心神失养", priority: "主要" }],
  },
};
const clinicalContext = "患者主诉与四诊记录：".repeat(500);
const evidenceContext = "【EVID-GUIDE-001】指南条目正文".repeat(800);
const tcmDispute = { status: "repair", issueCode: "tcm_reasoning_unsupported", repairInstruction: "病机词未在原文出现" };

// ── M03 ────────────────────────────────────────────────────────────────────
check("裁决触发条件仍然只有一个（本套件的裁剪按它做的特化）", () => {
  assert.ok(m03DiagnosticReviewNeedsAdjudication(tcmDispute));
  assert.ok(!m03DiagnosticReviewNeedsAdjudication({ status: "repair", issueCode: "criteria_not_met" }));
  assert.ok(!m03DiagnosticReviewNeedsAdjudication({ status: "accepted", issueCode: "none" }));
});

const m03First = buildM03DiagnosticReviewPrompt(clinicalContext, m03Reasoning, evidenceContext);
const m03Adjudication = buildM03DiagnosticReviewAdjudicationPrompt(clinicalContext, m03Reasoning, evidenceContext, tcmDispute);

check("M03 裁决载荷显著小于首轮（不再整份重发）", () => {
  assert.ok(m03Adjudication.length < m03First.length * 0.5,
    `裁决 ${m03Adjudication.length} 字符 vs 首轮 ${m03First.length}——应至少小一半`);
});
check("M03 裁决不再携带外部证据块（争的是事实接地，与指南无关）", () => {
  assert.ok(!m03Adjudication.includes("EVID-GUIDE-001"), "证据块仍被重发");
  assert.ok(m03First.includes("EVID-GUIDE-001"), "首轮应当带证据，否则对照失效");
});
check("M03 裁决不再携带首轮的 36 条审计规则", () => {
  assert.ok(m03First.includes("按七阶段做一次方证深度审计"), "首轮规则锚点失效");
  assert.ok(!m03Adjudication.includes("按七阶段做一次方证深度审计"),
    "裁决器被要求只裁决那一个争议，重发整套审计规则会诱导它重新审计全案");
});
check("M03 裁决仍带患者事实边界与服务端不变量（判断的立足点不能丢）", () => {
  assert.ok(m03Adjudication.includes("患者事实边界："), "缺患者事实，裁决无法核对接地");
  assert.ok(m03Adjudication.includes("服务端投影不变量"), "缺投影不变量会复发 summary_drift 误判");
  assert.ok(m03Adjudication.includes("服务端事实极性分类"), "缺情形一/二分类会错判有限信息病例");
});
check("M03 裁决携带争议本身与中医投影", () => {
  assert.ok(m03Adjudication.includes("首轮复核结论："));
  assert.ok(m03Adjudication.includes("心神失养"), "被争议的病机必须在载荷里");
  assert.ok(m03Adjudication.includes("被争议的M03中医投影"));
});
check("M03 裁决保留一行西医病案框架，但不带西医细节", () => {
  assert.ok(m03Adjudication.includes("失眠障碍"), "完全不给病案框架会让裁决器对本例定位失明");
  assert.ok(!m03Adjudication.includes("从事实到诊断倾向的推理"), "西医 clinicalRationale 与本争议无关");
  assert.ok(!m03Adjudication.includes("区分要点区分要点"), "西医鉴别细节与本争议无关");
});
check("M03 未知问题码保守回落到完整投影", () => {
  const fallback = buildM03DiagnosticReviewAdjudicationPrompt(
    clinicalContext, m03Reasoning, evidenceContext, { status: "repair", issueCode: "criteria_not_met" },
  );
  assert.ok(fallback.includes("从事实到诊断倾向的推理"),
    "判据放宽后应退化到今天的完整载荷，而不是退化成信息不足的裁决");
});

// ── M04 ────────────────────────────────────────────────────────────────────
const m04Prior = {
  overview: { primarySyndrome: "心脾两虚证", overallTherapy: "补益心脾" },
  pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "心神失养", therapyDirection: "养心安神" }] },
  therapy: { overallPrinciple: "补益心脾", subTherapies: [{ therapy: "养心安神", priority: "主要" }] },
  westernDiagnosis: { primary: { name: "失眠障碍", clinicalRationale: "西医推理正文".repeat(200) } },
  management: { mustCollect: Array.from({ length: 40 }, (_, i) => `补录项${i}`) },
};
const m04Candidate = {
  name: "归脾汤加减",
  herbs: Array.from({ length: 12 }, (_, i) => ({
    name: `药${i}`, dose: "10g", role: i === 0 ? "君" : "臣",
    function: "该药功用".repeat(10), targetRef: "P1", prescriptionRole: i === 0 ? "君" : "臣",
  })),
};
const emperorDispute = { status: "repair", issueCode: "herb_plan_mismatch", repairFocus: "emperor_role" };

check("M04 裁决触发条件仍然只有一个", () => {
  assert.ok(m04ClinicalReviewNeedsAdjudication(emperorDispute));
  assert.ok(!m04ClinicalReviewNeedsAdjudication({ status: "repair", issueCode: "herb_plan_mismatch", repairFocus: "dose" }));
});
const m04First = buildM04ClinicalReviewPrompt(clinicalContext, m04Prior, m04Candidate, evidenceContext);
const m04Adjudication = buildM04ClinicalReviewAdjudicationPrompt(clinicalContext, m04Prior, m04Candidate, evidenceContext, emperorDispute);
check("M04 裁决载荷小于首轮", () => {
  assert.ok(m04Adjudication.length < m04First.length,
    `裁决 ${m04Adjudication.length} 应小于首轮 ${m04First.length}`);
});
check("M04 裁决仍带君药裁决所需的一切：病机、治法、候选药味角色", () => {
  assert.ok(m04Adjudication.includes("心神失养"), "P1 核心病机必须在");
  assert.ok(m04Adjudication.includes("补益心脾"), "总治法必须在");
  assert.ok(m04Adjudication.includes("prescriptionRole"), "药味角色字段必须在");
  assert.ok(m04Adjudication.includes("上一复核器结构化意见："));
});
check("M04 未知 repairFocus 保守回落到完整首轮提示词", () => {
  const fallback = buildM04ClinicalReviewAdjudicationPrompt(
    clinicalContext, m04Prior, m04Candidate, evidenceContext,
    { status: "repair", issueCode: "formula_indication_mismatch" },
  );
  assert.ok(fallback.length >= m04First.length, "回落分支应包含完整首轮提示词");
});

// ── P4：max_tokens 策略 ────────────────────────────────────────────────────
const api = fs.readFileSync(path.join(process.cwd(), "src/lib/diagnosis-api.ts"), "utf8");
check("结构化调用按供应商建议不下发 max_tokens（严格 schema 生效时）", () => {
  const start = api.indexOf("function structuredMaxTokensParam(");
  const end = api.indexOf("function maxTokensForStructuredStage(", start);
  assert.ok(start > 0 && end > start, "切片越界，断言会空转");
  const body = api.slice(start, end);
  assert.ok(body.includes("if (supportsStrictJsonSchema(model)) return {};"),
    "严格 schema 路径必须完全不带 max_tokens——它会把 JSON 截断成无效输出");
});
check("回落到 json_object 的模型仍保留上限（那条路径没有解码器保证结构完整）", () => {
  const start = api.indexOf("function structuredMaxTokensParam(");
  const end = api.indexOf("function maxTokensForStructuredStage(", start);
  const body = api.slice(start, end);
  assert.ok(body.includes("max_tokens: overrideValue ?? maxTokensForStructuredStage(stage)"));
});
check("三处结构化调用都走同一个策略函数，没有漏网的裸 max_tokens", () => {
  // 允许的裸 max_tokens：M02 出题(3000)、复核(800)、探针(300/16)、事实相位等非结构化路径。
  const structuredBare = [...api.matchAll(/max_tokens: maxTokensForStructuredStage\(/g)];
  assert.equal(structuredBare.length, 0,
    `仍有 ${structuredBare.length} 处结构化调用直接下发 maxTokensForStructuredStage`);
});
check("服务端字节上限仍在——它才是真正的成本与安全边界", () => {
  assert.ok(api.includes("if (accumulatedContent.length > PRIMARY_TEXT_MAX_OUTPUT_CHARS)"),
    "移除 max_tokens 后，字节上限是唯一的输出兜底，不能一起去掉");
});

console.log(JSON.stringify({ checks, failures: 0 }));
