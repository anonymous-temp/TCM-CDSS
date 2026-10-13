import assert from "node:assert/strict";
import { createJiti } from "jiti";

// 语义层只为病历明确写出的现症提示和限制给药（2026-10-13，owner 决定；甲方 10.12 测评「红旗指征过度」）。
// 默认口径（redFlagExplicitOnly）：
//   · status=possible 的类目线索、「分不清本人还是他人」的线索：不提示、不进优先评估项；
//   · 处置去向「还差一个信息」：不提示；「宜先专科评估」只在依据已指向该情况（likely）时扣剂量；
//   · status=positive 的发现照旧（emergency 红旗，urgent/clarify 优先评估），处置去向立即急诊照旧。
// CDSS_REDFLAG_EXPLICIT_ONLY=false 恢复此前口径（机制本身由 test:clinical-facts / test:clinical-disposition 在该档位下测）。

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": "/dev/null" } });
const {
  additiveRedFlagsFromFacts,
  dispositionAdvisoriesFromFacts,
  dispositionEmergencyRedFlagsFromFacts,
  dispositionPriorityItemsFromFacts,
  priorityEvaluationItemsFromFacts,
  redFlagExplicitOnly,
  semanticTriageAdvisoriesFromFacts,
} = await jiti.import("../src/lib/clinical-facts.ts");

const source = "男，80岁，无痛性进行性皮肤巩膜黄染半月余，外院CT提示胰头部肿物，考虑胰腺癌。";
const categorySource = "胸口说不清地发紧，大便颜色偏深。今晨晕倒后被家人扶起。静息气促。家里有人胸痛。";
const finding = (category, status, urgency, quote, subject = "patient") => ({
  category, subject, status, urgency, quote,
  triageBasis: urgency === "emergency" ? "explicit_emergency" : urgency === "urgent" ? "urgent_review" : "clarification_needed",
});
const categoryFacts = { redFlags: [
  finding("cardiac", "possible", "clarify", "胸口说不清地发紧"),
  finding("gi_bleed", "possible", "clarify", "大便颜色偏深"),
  finding("syncope", "positive", "clarify", "晕倒后被家人扶起"),
  finding("respiratory", "positive", "urgent", "静息气促"),
  finding("cardiac", "positive", "urgent", "家里有人胸痛", "uncertain"),
] };
const disposition = (setting, plausibility, missingInfo) => ({ redFlags: [], disposition: {
  setting, mustNotMiss: [{ condition: "胰腺恶性肿瘤", plausibility, evidenceQuotes: ["考虑胰腺癌"] }], ...(missingInfo ? { missingInfo } : {}),
} });

function withSwitch(value, run) {
  const previous = process.env.CDSS_REDFLAG_EXPLICIT_ONLY;
  if (value == null) delete process.env.CDSS_REDFLAG_EXPLICIT_ONLY; else process.env.CDSS_REDFLAG_EXPLICIT_ONLY = value;
  try { return run(); } finally {
    if (previous == null) delete process.env.CDSS_REDFLAG_EXPLICIT_ONLY; else process.env.CDSS_REDFLAG_EXPLICIT_ONLY = previous;
  }
}

// ── 默认口径 ───────────────────────────────────────────────────────────────────────────────
withSwitch(null, () => {
  assert.equal(redFlagExplicitOnly(), true, "默认只认明确现症");
  const advisories = semanticTriageAdvisoriesFromFacts(categoryFacts, categorySource);
  const items = priorityEvaluationItemsFromFacts(categoryFacts, categorySource);
  for (const text of [...advisories, ...items]) {
    assert.ok(!text.includes("胸口说不清地发紧") && !text.includes("大便颜色偏深"), `「可能」的线索不应出现：${text}`);
    assert.ok(!text.includes("家里有人胸痛"), `主体不明的线索不应出现：${text}`);
  }
  assert.ok(items.some((text) => text.includes("“晕倒后被家人扶起”")), "病历明写的晕倒事件（positive+clarify）仍要求处方前澄清");
  assert.ok(items.some((text) => text.includes("“静息气促”")), "positive+urgent 仍要求优先评估");
  assert.ok(advisories.some((text) => text.includes("“静息气促”")), "positive+urgent 仍有提示");
  assert.equal(items.length, 2, "只有两条明确现症进入优先评估");

  assert.deepEqual(dispositionPriorityItemsFromFacts(disposition("urgent_specialist", "possible"), source), [], "仅仅不能排除：不扣剂量");
  assert.ok(dispositionPriorityItemsFromFacts(disposition("urgent_specialist", "likely"), source)[0]?.includes("“考虑胰腺癌”"),
    "病历依据已指向（影像提示占位）：仍要求先做专科评估");
  assert.deepEqual(dispositionAdvisoriesFromFacts(disposition("insufficient_info", "possible", "黄疸是否伴发热寒战"), source), [], "还差一个信息：交给追问，不另出提示");
  assert.ok(dispositionPriorityItemsFromFacts(disposition("emergency", "possible"), source)[0]?.includes("立即急诊"), "立即急诊一档不受影响");
  assert.equal(dispositionEmergencyRedFlagsFromFacts(disposition("emergency", "possible"), source).length, 1, "立即急诊仍是红旗");
  const emergency = { redFlags: [finding("respiratory", "positive", "emergency", "静息气促")] };
  assert.equal(additiveRedFlagsFromFacts(emergency, categorySource, []).length, 1, "positive+emergency 仍是红旗");
  assert.equal(additiveRedFlagsFromFacts({ redFlags: [finding("cardiac", "possible", "emergency", "胸口说不清地发紧")] }, categorySource, []).length, 0,
    "possible 从来不是红旗（此前即如此）");
});

// ── 回退档：此前口径原样恢复 ────────────────────────────────────────────────────────────────
withSwitch("false", () => {
  assert.equal(redFlagExplicitOnly(), false);
  const items = priorityEvaluationItemsFromFacts(categoryFacts, categorySource);
  assert.ok(items.some((text) => text.includes("胸口说不清地发紧") || text.includes("大便颜色偏深")), "回退档：possible 线索重新进入优先评估");
  assert.ok(dispositionPriorityItemsFromFacts(disposition("urgent_specialist", "possible"), source)[0]?.includes("“考虑胰腺癌”"), "回退档：possible 的专科评估恢复");
  assert.equal(dispositionAdvisoriesFromFacts(disposition("insufficient_info", "possible", "黄疸是否伴发热寒战"), source).length, 1, "回退档：补问提示恢复");
});

console.log("redflag explicit-only: ok");
