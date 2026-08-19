import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  applyGovernedTcmDiagnosticCitations,
  tcmDiseaseStandardCitations,
  tcmSyndromeStandardCitations,
} = await jiti.import("../src/lib/tcm-diagnostic-citations.ts");
const { buildEvidenceOutputTransform } = await jiti.import("../src/lib/cdss-evidence-context.ts");

assert.deepEqual(
  tcmDiseaseStandardCitations("吐酸").map((item) => item.evidenceId),
  ["STD-GBT-15657-2021"],
);
assert.deepEqual(
  tcmSyndromeStandardCitations("脾胃虚弱证").map((item) => item.evidenceId),
  ["STD-GBT-16751-2-2021"],
);
assert.deepEqual(
  tcmSyndromeStandardCitations("脾胃虚弱，湿浊中阻").map((item) => item.evidenceId),
  ["STD-GBT-16751-2-2021"],
  "并列的国标证候应绑定同一证候术语标准",
);
assert.deepEqual(
  tcmSyndromeStandardCitations("脾胃虚弱，项目扩展未核验证候"),
  [],
  "并列项中任一条未进入国标词表时不得借另一条冒领标准引用",
);
assert.deepEqual(tcmSyndromeStandardCitations("项目扩展未核验证候"), []);

const reasoning = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { tcmDiseaseName: "吐酸", primarySyndrome: "脾胃虚弱证" },
};
const content = [
  "# 诊断",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify(reasoning),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");
const transformed = applyGovernedTcmDiagnosticCitations(content);
const parsed = JSON.parse(transformed.match(/DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END/)?.[1] || "{}");
assert.equal(parsed.overview.tcmDiseaseReferences[0].sourceType, "standard");
assert.equal(parsed.overview.tcmSyndromeReferences[0].sourceType, "standard");
assert.equal(applyGovernedTcmDiagnosticCitations(transformed), transformed, "citation projection must be idempotent");

const evidencePass = buildEvidenceOutputTransform(
  "[EVID-GUIDE-001] 普通西医诊断指南（测试机构，2026）：仅用于验证证据净化边界。",
  undefined,
  { id: "tcm-standard-preservation", phase: "diagnose", patient: {}, chiefComplaint: "胃脘隐痛", symptoms: {}, conversation: [] },
)(transformed);
const evidencePassParsed = JSON.parse(evidencePass
  .match(/DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END/)?.[1] || "{}");
assert.deepEqual(
  evidencePassParsed.overview.tcmDiseaseReferences?.map((item) => item.evidenceId),
  ["STD-GBT-15657-2021"],
  "证据输出投影不得把服务端绑定的中医病名国标依据清空",
);

const extensionReasoning = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { tcmDiseaseName: "嗳气", primarySyndrome: "脾胃虚弱，湿浊中阻" },
  westernDiagnosis: {
    primary: {
      guidelineReferences: [{
        evidenceId: "EVID-GUIDE-BELCHING",
        citation: "嗳气中医诊疗专家共识（2023）（中华中医药学会脾胃病分会，2024）",
        sourceType: "guideline",
      }],
    },
  },
};
const extensionContent = [
  "# 诊断",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify(extensionReasoning),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");
const extensionParsed = JSON.parse(applyGovernedTcmDiagnosticCitations(extensionContent)
  .match(/DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END/)?.[1] || "{}");
assert.deepEqual(
  extensionParsed.overview.tcmDiseaseReferences.map((item) => item.evidenceId),
  ["EVID-GUIDE-BELCHING"],
  "教材扩展病名只可复用题名明确命中该病名的本轮受治理指南",
);
assert.deepEqual(
  extensionParsed.overview.tcmSyndromeReferences.map((item) => item.evidenceId),
  ["STD-GBT-16751-2-2021"],
);

const unrelatedExtension = JSON.parse(JSON.stringify(extensionReasoning));
unrelatedExtension.westernDiagnosis.primary.guidelineReferences[0].citation = "失眠障碍诊疗指南（2025）";
const unrelatedContent = extensionContent.replace(JSON.stringify(extensionReasoning), JSON.stringify(unrelatedExtension));
const unrelatedParsed = JSON.parse(applyGovernedTcmDiagnosticCitations(unrelatedContent)
  .match(/DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END/)?.[1] || "{}");
assert.deepEqual(unrelatedParsed.overview.tcmDiseaseReferences, [], "不相关指南不得替扩展病名背书");

console.log(JSON.stringify({ suite: "tcm-diagnostic-citations", standards: 2, failures: 0 }));
