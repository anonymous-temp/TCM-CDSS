import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  getCdssKnowledgeTelemetrySnapshot,
  recordCdssKnowledgeTrace,
  resetCdssKnowledgeTelemetry,
} = await import("../src/lib/cdss-knowledge-telemetry.ts");

resetCdssKnowledgeTelemetry();
recordCdssKnowledgeTrace({
  stage: "diagnose",
  evidenceContext: [
    "## EviMed 指南/共识检索",
    "检索词：反酸 嗳气 胃食管反流 指南",
    "[EVID-GUIDE-001] 胃食管反流病基层诊疗指南",
    "[LOCAL-KB-001] 本地知识条目",
  ].join("\n"),
  finalContent: [
    '<!-- DIAGNOSIS_JSON_START -->',
    JSON.stringify({
      stage: "diagnose",
      westernDiagnosis: { primary: { guidelineReferences: [{ evidenceId: "EVID-GUIDE-001" }] } },
      contractSignature: `hmac-sha256:${"a".repeat(64)}`,
    }),
    '<!-- DIAGNOSIS_JSON_END -->',
  ].join("\n"),
});

recordCdssKnowledgeTrace({
  stage: "prescribe",
  evidenceContext: "检索词：失眠 心脾两虚\n[EVID-INST-001] 说明书条目",
  finalContent: `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "prescribe", contractSignature: `hmac-sha256:${"b".repeat(64)}` })}\n<!-- DIAGNOSIS_JSON_END -->`,
});

const snapshot = getCdssKnowledgeTelemetrySnapshot();
assert.equal(snapshot.schemaVersion, "tcm-cdss-knowledge-telemetry-v1");
assert.equal(snapshot.total, 2);
assert.equal(snapshot.zeroReferenceFinals, 1);
assert.equal(snapshot.stages.diagnose.total, 1);
assert.equal(snapshot.stages.diagnose.injectedIds, 2);
assert.equal(snapshot.stages.diagnose.referencedIds, 1);
assert.match(snapshot.recent[0].queryHashes[0], /^sha256:[a-f0-9]{16}$/);
assert.deepEqual(snapshot.recent[0].injectedIds, ["EVID-GUIDE-001", "LOCAL-KB-001"]);
assert.deepEqual(snapshot.recent[0].referencedIds, ["EVID-GUIDE-001"]);
assert.doesNotMatch(JSON.stringify(snapshot), /反酸|嗳气|胃食管反流|失眠|心脾两虚/, "诊断检索原文不得进入遥测");

const healthSource = readFileSync(new URL("../src/app/api/diagnosis/health/route.ts", import.meta.url), "utf8");
assert.match(healthSource, /getCdssKnowledgeTelemetrySnapshot/);
assert.match(healthSource, /knowledgeTelemetry:\s*getCdssKnowledgeTelemetrySnapshot\(\)/);

resetCdssKnowledgeTelemetry();
console.log(JSON.stringify({ suite: "knowledge-telemetry", failures: 0 }));
