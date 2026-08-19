import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  applyGovernedTcmDiagnosticCitations,
  tcmDiseaseStandardCitations,
  tcmSyndromeStandardCitations,
} = await jiti.import("../src/lib/tcm-diagnostic-citations.ts");

assert.deepEqual(
  tcmDiseaseStandardCitations("吐酸").map((item) => item.evidenceId),
  ["STD-GBT-15657-2021"],
);
assert.deepEqual(
  tcmSyndromeStandardCitations("脾胃虚弱证").map((item) => item.evidenceId),
  ["STD-GBT-16751-2-2021"],
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

console.log(JSON.stringify({ suite: "tcm-diagnostic-citations", standards: 2, failures: 0 }));
