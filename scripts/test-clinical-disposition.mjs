/**
 * 开方前处置去向（clinical-facts ClinicalDisposition）的确定性一半。
 *
 * 语义判断本身在实机评测里量（~/runlogs/disposition-20260926，配对 v22/v24）；这里钉住不需要模型的部分：
 *   ① 解析：setting 闭集、升档必须带「必须排除」清单、自由文本病名只限长度不限词表、
 *      处置段不合格时整段丢弃而不连累同一份输出里的 redFlags。
 *   ② 接地：依据必须逐字出自原文且为当前事实；被否认、已缓解的不算；疑似措辞（考虑/可能）算。
 *   ③ 门禁映射：emergency → 红旗 + 扣剂量；urgent_specialist → 扣剂量；insufficient_info → 只提示不扣；
 *      outpatient_ok / 接不上地 → 无影响。
 *   ④ 签名覆盖：处置去向在签名载荷里——客户端删掉它，签名即失效。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

delete process.env.CDSS_CLINICAL_FACTS_BACKSTOP;
process.env.CLINICAL_FACTS_ATTESTATION_KEY = "clinical-disposition-test-key-2026";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { parseClinicalFacts, dispositionPriorityItemsFromFacts, buildClinicalFactsExtractionPrompt } =
  await jiti.import("../src/lib/clinical-facts.ts");
const { maybeAttachClinicalFactsBackstop, hasValidClinicalFactsAttestation } =
  await jiti.import("../src/lib/clinical-facts-runtime.ts");
const { evaluateSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");

let cases = 0;
const ok = (value, message) => { assert.ok(value, message); cases += 1; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); cases += 1; };

// ① 解析
const base = { redFlags: [{ category: "cardiac", subject: "patient", status: "negative", urgency: "routine", triageBasis: "routine_care", quote: "否认胸痛" }] };
const parsed = parseClinicalFacts({ ...base, disposition: {
  setting: "urgent_specialist",
  mustNotMiss: [{ condition: "胫骨平台骨折伴关节面塌陷", plausibility: "likely", evidenceQuotes: ["车祸伤后左膝疼痛", "a", "x".repeat(300)] }],
  rationale: "外伤后关节结构损伤需骨科评估",
} });
eq(parsed.disposition?.setting, "urgent_specialist", "合法处置段应被解析");
eq(parsed.disposition?.mustNotMiss[0].evidenceQuotes, ["车祸伤后左膝疼痛"], "过短/过长的依据片段应被剔除");
eq(parseClinicalFacts({ ...base, disposition: { setting: "refer_somewhere", mustNotMiss: [] } }).disposition, undefined, "setting 不在闭集时整段丢弃");
eq(parseClinicalFacts({ ...base, disposition: { setting: "emergency", mustNotMiss: [] } }).disposition, undefined, "升档却说不出要排除什么，整段丢弃");
eq(parseClinicalFacts({ ...base, disposition: { setting: "outpatient_ok", mustNotMiss: [] } }).disposition?.setting, "outpatient_ok", "outpatient_ok 本身不需要依据");
eq(parseClinicalFacts({ ...base, disposition: { setting: "urgent_specialist", mustNotMiss: [{ condition: "病".repeat(61), plausibility: "likely", evidenceQuotes: ["左膝疼痛"] }] } }).disposition, undefined, "病名过长的条目被剔除后清单为空，整段丢弃");
eq(parseClinicalFacts({ ...base, disposition: "garbage" }).redFlags.length, 1, "处置段不合格不得连累同一份输出里的 redFlags");
ok(buildClinicalFactsExtractionPrompt("头晕").includes("开方前处置去向"), "提示词里仍有处置去向一节");

// ② 接地（直接调消费函数）
const facts = (setting, quotes, missingInfo) => ({ redFlags: [], disposition: {
  setting, mustNotMiss: [{ condition: "需排除的情况", plausibility: "possible", evidenceQuotes: quotes }], ...(missingInfo ? { missingInfo } : {}) } });
const source = "男，80岁，无痛性进行性皮肤巩膜黄染半月余，外院CT提示胰头部肿物，考虑胰腺癌。否认胸痛。3年前曾右膝外伤，已痊愈。";
ok(dispositionPriorityItemsFromFacts(facts("urgent_specialist", ["考虑胰腺癌"]), source)[0]?.includes("“考虑胰腺癌”"), "疑似措辞（考虑…）是这一层要处理的对象，应接地");
eq(dispositionPriorityItemsFromFacts(facts("urgent_specialist", ["胰头部肿块"]), source), [], "依据不在原文里，不升档");
eq(dispositionPriorityItemsFromFacts(facts("urgent_specialist", ["胸痛"]), source), [], "被否认的事实不能作为依据");
eq(dispositionPriorityItemsFromFacts(facts("urgent_specialist", ["右膝外伤"]), source), [], "已痊愈的既往事件不能作为依据");
eq(dispositionPriorityItemsFromFacts(facts("urgent_specialist", ["考虑胰腺癌"]), source, ["…原文依据：“考虑胰腺癌”"]), [], "已有条目引用了同一原文时不重复");

// ③ 门禁映射：走真实的 抽取→接地→签名→门禁 链路，模型调用用桩
const TEXT = "车祸伤后左膝疼痛3小时，左膝关节肿胀，轻度外翻畸形，主动活动受限。舌淡红，苔薄白，脉弦。";
function caseState(id) {
  return {
    id, customerId: undefined, phase: "done", patient: { sex: "男", age: 54 },
    chiefComplaint: TEXT, symptoms: { presentHistory: TEXT }, tongue: "舌淡红，苔薄白", pulse: "脉弦",
    vitals: { T: "36.6℃", P: "78次/分", R: "18次/分", BP: "126/80mmHg" },
    pastHistory: "既往体健。", medicationHistory: "否认当前用药", allergyHistory: "否认药物过敏",
    completeness: { level: "C", redFlag: 0.8, infoGain: 1, managementImpact: 1, answerability: 1 },
    questionRounds: 1, maxQuestionRounds: 1, conversation: [],
  };
}
const stub = (disposition) => async () => JSON.stringify({ redFlags: [], disposition, encounterScope: { status: "active_current_target", quote: "左膝疼痛3小时" } });
async function gateWith(label, disposition) {
  const state = await maybeAttachClinicalFactsBackstop(caseState(`disp-${label}`), stub(disposition));
  ok(state.clinicalFacts?.semanticStatus === "checked", `${label}: 桩抽取应落成 checked`);
  return { state, gate: evaluateSafetyGate(state) };
}
const evidence = { condition: "胫骨平台骨折或膝关节结构损伤", plausibility: "likely", evidenceQuotes: ["车祸伤后左膝疼痛3小时", "轻度外翻畸形"] };
const baseline = await gateWith("ok", { setting: "outpatient_ok", mustNotMiss: [] });
eq([baseline.gate.status, baseline.gate.allowDosePrescription], ["ready", true], "outpatient_ok：该病例本应 ready 放行（否则下面的扣剂量断言分辨不出原因）");

const urgent = await gateWith("urgent", { setting: "urgent_specialist", mustNotMiss: [evidence] });
eq(urgent.gate.allowDosePrescription, false, "urgent_specialist 必须扣剂量");
ok(urgent.gate.missingItems.some((item) => item.includes("开方前处置去向") && item.includes("胫骨平台骨折")), "扣剂量的条目要写出需排除的自由文本病名");
eq(urgent.gate.redFlags.length, 0, "urgent_specialist 不形成红旗");

const emergency = await gateWith("emergency", { setting: "emergency", mustNotMiss: [evidence] });
eq([emergency.gate.status, emergency.gate.allowDosePrescription], ["red_flag", false], "emergency：红旗 + 扣剂量");
ok(emergency.gate.redFlags.some((flag) => flag.includes("需立即急诊评估") && flag.includes("原文依据")), "急诊红旗带原文依据");

const unclear = await gateWith("unclear", { setting: "insufficient_info", mustNotMiss: [evidence], missingInfo: "膝关节能否负重？" });
eq([unclear.gate.status, unclear.gate.allowDosePrescription], ["ready", true], "insufficient_info 只提示、不扣剂量");
ok(unclear.gate.advisories.some((item) => item.includes("建议补问") && item.includes("膝关节能否负重")), "insufficient_info 要把该问的问题提示给医生");

const ungrounded = await gateWith("ungrounded", { setting: "emergency", mustNotMiss: [{ ...evidence, evidenceQuotes: ["左膝开放性骨折"] }] });
eq([ungrounded.gate.status, ungrounded.gate.allowDosePrescription], ["ready", true], "依据接不上地的升档不作数");

// ④ 签名覆盖
ok(hasValidClinicalFactsAttestation(urgent.state.clinicalFacts), "原样回传的签名应有效");
const stripped = { ...urgent.state.clinicalFacts };
delete stripped.disposition;
ok(!hasValidClinicalFactsAttestation(stripped), "删掉处置去向后签名必须失效，否则客户端可以把「宜先专科评估」变回放行剂量");
const downgraded = { ...urgent.state.clinicalFacts, disposition: { ...urgent.state.clinicalFacts.disposition, setting: "outpatient_ok" } };
ok(!hasValidClinicalFactsAttestation(downgraded), "把 setting 改成 outpatient_ok 后签名必须失效");

console.log(JSON.stringify({ suite: "clinical-disposition", cases, failures: 0 }));
