import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { sanitizeUngroundedRedFlagNegations } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

function stateFromRecord(text) {
  return {
    patient: { age: 35, sex: "男" },
    chiefComplaint: "轻微头痛1天",
    symptoms: { presentHistory: text },
    conversation: [],
  };
}

function sanitizeReasoning(state, reasoning, prose = "") {
  const content = [
    prose,
    "<!-- DIAGNOSIS_JSON_START -->",
    JSON.stringify(reasoning),
    "<!-- DIAGNOSIS_JSON_END -->",
  ].join("\n");
  const sanitized = sanitizeUngroundedRedFlagNegations(content, state);
  const json = JSON.parse(sanitized.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  return { sanitized, json };
}

const unexamined = stateFromRecord("轻微头痛1天，伴畏光；无发热、呕吐。未记录现场查体。");
const fabricated = sanitizeReasoning(unexamined, {
  westernDiagnosis: {
    primary: {
      name: "头痛待查",
      clinicalRationale: "肺部听诊未见啰音，神经系统查体未见异常，结合头痛病程考虑原发性头痛。",
      limitations: [],
      guidelineReferences: [{ citation: "指南鉴别标准示例：肺部听诊未闻及啰音", url: "https://example.invalid/guideline" }],
    },
  },
  overview: { tcmDiagnosticRationale: "双肺呼吸音清晰，现有表现倾向风邪上扰。" },
}, "临床分析：肺部听诊未见干湿啰音，暂未见呼吸系统异常。\n参考文献：指南鉴别标准：肺部听诊未闻及啰音。");
assert.doesNotMatch(fabricated.sanitized, /肺部听诊未见|双肺呼吸音清晰|神经系统查体未见异常/);
assert.match(fabricated.sanitized, /本次病历未记录肺部听诊结果/);
assert.match(fabricated.json.westernDiagnosis.primary.clinicalRationale, /本次病历未记录肺部听诊结果/);
assert.match(fabricated.json.westernDiagnosis.primary.clinicalRationale, /本次病历未记录神经系统查体结果/);
assert.ok(fabricated.json.westernDiagnosis.primary.limitations.some((item) => item.includes("肺部听诊结果")));
assert.ok(fabricated.json.westernDiagnosis.primary.limitations.some((item) => item.includes("神经系统查体结果")));
assert.match(fabricated.json.westernDiagnosis.primary.guidelineReferences[0].citation, /肺部听诊未闻及啰音/, "reference criteria are not patient assertions");
assert.match(fabricated.sanitized, /参考文献：指南鉴别标准：肺部听诊未闻及啰音/, "visible guideline text must remain an external criterion, not be rewritten as a patient fact gap");

const evidence = { evidenceLevel: "insufficient", source: "病例证据不足", confidence: "低" };
const projectedReference = synchronizeVisibleClinicalSummary([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: { primarySyndrome: "待补充", primarySyndromeResolution: "unresolved", primarySyndromeBasis: [], overallPathogenesis: "待补充", overallTherapy: "待补充", evidence },
    westernDiagnosis: {
      primary: { name: "头痛待查", status: "证据有限", confidence: "低", supportingFacts: ["轻微头痛1天"], limitations: [], suggestedChecks: [], evidence },
      differentials: [{
        name: "呼吸系统疾病",
        reason: "需临床鉴别",
        distinguishingPoints: "需结合查体",
        nextCheck: "医生现场查体",
        guidelineReferences: [{ evidenceId: "GUIDE-EXAM-1", citation: "指南鉴别标准：肺部听诊未闻及啰音", sourceType: "guideline" }],
      }],
    },
    pathogenesis: { summary: "待补充", locationDifferentiation: { items: [], resolution: "unresolved", evidence }, natureDifferentiation: { items: [], resolution: "unresolved", evidence }, chain: [], uncertainties: [] },
    therapy: { overallPrinciple: "待补充", subTherapies: [] },
    formula: null,
    nonPharma: null,
    lineageAdaptation: null,
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), "diagnose");
assert.match(projectedReference, /- \*\*参考文献\*\*：指南鉴别标准：肺部听诊未闻及啰音/, "fixture must exercise the actual visible Markdown reference shape");
const sanitizedProjectedReference = sanitizeUngroundedRedFlagNegations(projectedReference, unexamined);
assert.match(sanitizedProjectedReference, /- \*\*参考文献\*\*：指南鉴别标准：肺部听诊未闻及啰音/, "actual visible reference rows must remain byte-semantic references after grounding");

for (const claim of [
  "心音正常，未闻及杂音。",
  "腹软，无压痛及反跳痛。",
  "双侧肌力正常，病理征阴性。",
]) {
  const result = sanitizeReasoning(unexamined, {
    westernDiagnosis: { primary: { name: "症状性诊断", clinicalRationale: claim, limitations: [] } },
  });
  assert.doesNotMatch(result.json.westernDiagnosis.primary.clinicalRationale, new RegExp(claim.replace(/[。]/g, "")));
  assert.match(result.json.westernDiagnosis.primary.clinicalRationale, /本次病历未记录/);
}

const examined = stateFromRecord("轻微头痛1天。查体：双肺呼吸音清，未闻及干湿啰音；神经系统查体未见异常。");
const preserved = sanitizeReasoning(examined, {
  westernDiagnosis: {
    primary: {
      name: "头痛待查",
      clinicalRationale: "双肺未闻及干湿啰音；神经系统查体未见异常。",
      limitations: [],
    },
  },
});
assert.match(preserved.json.westernDiagnosis.primary.clinicalRationale, /双肺未闻及干湿啰音/);
assert.match(preserved.json.westernDiagnosis.primary.clinicalRationale, /神经系统查体未见异常/);

const contradicted = sanitizeReasoning(unexamined, {
  westernDiagnosis: {
    primary: {
      name: "头痛待查",
      clinicalRationale: "病历尚未确认头痛是否存在。",
      limitations: ["病历尚未确认头痛是否存在。"],
    },
  },
});
assert.doesNotMatch(contradicted.json.westernDiagnosis.primary.clinicalRationale, /尚未确认头痛/);
assert.doesNotMatch(JSON.stringify(contradicted.json.westernDiagnosis.primary.limitations), /尚未确认头痛/);

for (let iteration = 0; iteration < 20; iteration += 1) {
  const repeated = sanitizeReasoning(unexamined, {
    westernDiagnosis: { primary: { name: "头痛待查", clinicalRationale: "肺部听诊未见啰音。", limitations: [] } },
  });
  assert.doesNotMatch(repeated.sanitized, /肺部听诊未见啰音/, `iteration ${iteration + 1}`);
}

console.log(JSON.stringify({ suite: "exam-claim-grounding", checks: 32, failures: 0 }));
