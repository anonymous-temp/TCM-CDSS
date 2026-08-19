import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { buildEvidenceOutputTransform } = await jiti.import("../src/lib/cdss-evidence-context.ts");

const context = [
  "[EVID-GUIDE-001] ACG Clinical Guideline for the Diagnosis and Management of Gastroesophageal Reflux Disease（American College of Gastroenterology，2022，PMID:34807007）：胃食管反流病诊断与鉴别摘要。 URL:https://pubmed.ncbi.nlm.nih.gov/34807007/",
  "[EVID-PAPER-002] Functional Dyspepsia: Evaluation and Management（American Family Physician，2020，PMID:31939638）：功能性消化不良鉴别摘要。 URL:https://pubmed.ncbi.nlm.nih.gov/31939638/",
].join("\n");
const caseState = {
  id: "differential-citation",
  phase: "diagnose",
  patient: { sex: "女", age: 78 },
  chiefComplaint: "反酸、嗳气反复1年",
  symptoms: {},
  conversation: [],
};
const payload = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { primarySyndrome: "脾胃虚弱证" },
  westernDiagnosis: {
    primary: { name: "反酸", guidelineRefs: [{ evidenceId: "EVID-GUIDE-001", appliesTo: "支持反酸鉴别" }] },
    differentials: [
      { name: "胃食管反流病", reason: "需鉴别", distinguishingPoints: "需客观检查", nextCheck: "胃镜" },
      { name: "功能性消化不良", reason: "需鉴别", distinguishingPoints: "餐后不适", nextCheck: null },
    ],
  },
};
const transformed = buildEvidenceOutputTransform(context, undefined, caseState)(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(payload)}\n<!-- DIAGNOSIS_JSON_END -->`,
);
const parsed = JSON.parse(transformed.match(/DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END/)?.[1] || "{}");
const [gerd, dyspepsia] = parsed.westernDiagnosis.differentials;
assert.equal(gerd.guidelineReferences[0].evidenceId, "EVID-GUIDE-001");
assert.equal(gerd.guidelineReferences[0].sourceType, "guideline");
assert.equal(dyspepsia.guidelineReferences[0].evidenceId, "EVID-PAPER-002");
assert.equal(dyspepsia.guidelineReferences[0].sourceType, "literature");
for (const differential of [gerd, dyspepsia]) {
  const citation = differential.guidelineReferences[0].citation;
  assert.doesNotMatch(citation, /支持|本例|病例|思考|推理/);
  assert.match(citation, /20\d{2}/);
}
assert.equal(parsed.westernDiagnosis.primary.guidelineReferences[0].appliesTo, "支持反酸鉴别", "后台适用说明仍保留");

console.log(JSON.stringify({ suite: "western-differential-citations", differentials: 2, failures: 0 }));
