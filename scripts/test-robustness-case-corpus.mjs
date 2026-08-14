// 77 案鲁棒性夹具的离线治理闸门。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sourcePath = path.join(repoRoot, "src/data/tcm-robustness-cases.source.json");
const corpus = JSON.parse(readFileSync(sourcePath, "utf8"));

assert.equal(corpus.schemaVersion, "tcm-cdss-robustness-cases-v1");
assert.equal(corpus.evaluationOnly, true);
assert.equal(corpus.runtimeRetrievalAllowed, false);
assert.equal(corpus.cases.length, 77, "鲁棒性回归夹具必须恰好 77 案");
assert.equal(new Set(corpus.cases.map((item) => item.id)).size, 77, "病例 id 不得重复");

const publicCases = corpus.cases.filter((item) => item.id.startsWith("public-"));
const modernCases = corpus.cases.filter((item) => item.id.startsWith("modern-"));
assert.equal(publicCases.length, 20);
assert.equal(modernCases.length, 57);
assert.equal(new Set(modernCases.map((item) => item.category)).size, 57,
  "现代病案应按病种轮转，不能被单一高频病种占满");
assert.equal(corpus.cases.filter((item) => item.expectation === "should_not_prescribe_redflag").length, 7);
assert.equal(corpus.cases.filter((item) => item.expectation === "should_prescribe").length, 66);
assert.equal(corpus.cases.filter((item) => item.expectation === "should_downgrade_incomplete").length, 4);

const forbiddenLeakageKeys = ["formula", "expectedFormula", "expectedFormulaNames", "syndrome", "treatmentPrinciple"];
const dob = /出生日期|出生于\s*\d{4}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*出生/;
for (const item of corpus.cases) {
  assert.ok(item.chiefComplaint.length >= 4, `${item.id} 主诉过短`);
  assert.ok(item.presentIllness.length >= 4, `${item.id} 现病资料过短`);
  assert.ok(item.tongue.length >= 2, `${item.id} 缺舌象`);
  assert.ok(item.pulse.length >= 2, `${item.id} 缺脉象`);
  assert.ok(item.sourceUrl.startsWith("http"), `${item.id} 缺可定位来源`);
  assert.ok(item.sourceRef, `${item.id} 缺源内锚点`);
  for (const key of forbiddenLeakageKeys) assert.ok(!(key in item), `${item.id} 泄漏金标准字段 ${key}`);
  assert.doesNotMatch(JSON.stringify(item), dob, `${item.id} 含出生日期准标识符`);
}
for (const item of publicCases) assert.ok(!item.sourceUrl.includes("github.com"), `${item.id} 应保留原始公开网页 URL`);
for (const item of modernCases) {
  assert.match(item.sourceRef, /Medical Records\.txt#L\d+$/);
  assert.match(item.governanceRef, /^ADJ-20260726-MODERN-CASE-REPLAY-POOL/);
}

// 所有被声明为红旗的病例必须由当前确定性承重层实际检出；夹具标签不能自说自话。
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { withSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");
for (const item of corpus.cases.filter((entry) => entry.expectation === "should_not_prescribe_redflag")) {
  const text = `${item.chiefComplaint}。${item.presentIllness}`;
  const state = withSafetyGate({
    id: `fixture-${item.id}`,
    phase: "diagnose",
    patient: { sex: item.sex, ...(Number(item.age) ? { age: Number(item.age) } : {}) },
    chiefComplaint: item.chiefComplaint,
    symptoms: { general: item.presentIllness, tcmFourExams: item.fourExamDetail },
    tongue: item.tongue,
    pulse: item.pulse,
    vitals: "",
    labs: item.labs,
    pastHistory: item.pastHistory,
    medicationHistory: item.medicationHistory,
    allergyHistory: item.allergyHistory,
    questionRounds: 1,
    maxQuestionRounds: 1,
    conversation: [],
    diagnosis: "",
    prescription: "",
    riskAssessment: "",
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1",
      source: "tcm-cdss-his",
      caseId: `fixture-${item.id}`,
      updatedAt: "2026-08-14T00:00:00.000Z",
      tongueImageUploaded: false,
      fields: { zhushu: item.chiefComplaint, xianbingshi: text, tcmTongue: item.tongue, tcmPulse: item.pulse },
      rawText: text,
    },
  });
  assert.ok(state.safetyGate.redFlags.length > 0, `${item.id} 声明为红旗但确定性层未检出`);
}

for (const item of corpus.cases.filter((entry) => entry.expectation === "should_downgrade_incomplete")) {
  const age = Number(String(item.age || "").replace(/[^\d.]/g, ""));
  assert.ok(age > 0 && age < 18, `${item.id} 信息不足降级标签应由儿科剂量规则缺口驱动`);
}

const reproducibility = spawnSync(process.execPath, ["scripts/build-robustness-case-corpus.mjs", "--check"], {
  cwd: repoRoot,
  encoding: "utf8",
});
assert.equal(reproducibility.status, 0, `77 案夹具不可复现：${reproducibility.stderr || reproducibility.stdout}`);

console.log(JSON.stringify({
  suite: "robustness-case-corpus",
  cases: corpus.cases.length,
  publicCases: publicCases.length,
  governedModernCases: modernCases.length,
  redFlagCases: 7,
  incompleteCases: 4,
}));
