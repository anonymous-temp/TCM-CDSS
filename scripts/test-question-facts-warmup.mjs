import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

// 答题期事实层预热（2026-09-28）：医生选齐追问答案后，页面用与提交完全相同的构造函数把病例先发给 red-flags
// （?prefetch=diagnose 顺带预取 M03 前置输入）。事实层按病历文本指纹缓存，所以提交时 red-flags 与 M03 都命中。
// 这里钉住：预热与两条提交支路发出的病例文本指纹相同；提交路径确实改用同一个构造函数；接线存在。
const jiti = createJiti(import.meta.url, { jsx: true, alias: {
  "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const client = await jiti.import("../src/app/diagnosis/DiagnosisClient.tsx");
const { createInitialCaseState } = await jiti.import("../src/lib/diagnosis-types.ts");
const { sanitizeCaseStateForModel, trustedInputText } = await jiti.import("../src/lib/diagnosis-safety.ts");

const failures = [];
let checks = 0;
const check = (name, fn) => { checks++; try { fn(); } catch (error) { failures.push({ name, message: error.message }); } };

const draft = {
  patientName: "", sex: "女", age: "46岁", zhushu: "胃脘胀痛1月", xianbingshi: "胃脘胀痛，食后加重，嗳气。",
  jiwangshi: "否认高血压、糖尿病", allergyHistory: "否认药物过敏", medicationHistory: "未服药",
  vitalsT: "36.6", vitalsP: "76", vitalsR: "18", vitalsBP: "118/76", vitalsDetail: "",
  tcmFace: "", tcmPulse: "弦", tcmTongue: "舌淡红，苔薄白", tcmDetail: "", tcmLineagePreference: "",
  herbCountPreference: "", clinicTreatmentCapabilities: "", fuzhuJiancha: "",
};
const base = { ...createInitialCaseState(), id: "warmup-fixture", customerId: "hospital-a", phase: "question",
  conversation: [{ role: "assistant", content: "1. 胀痛与情绪波动是否相关？" }] };
const caseState = client.withSafetyGateAndOperationalCompleteness(client.applyDraftToCaseState(base, draft, "", false));
const selections = { 1: { questionId: "1", answer: "情绪不畅时胀痛明显加重", kind: "clinical_fact" } };
const fingerprintText = (state) => trustedInputText(sanitizeCaseStateForModel(state));

check("the shared builder produces the answered case exactly once per submission", () => {
  const prepared = client.buildQuestionAnswerSubmission(caseState, draft, selections, "", false);
  assert.ok(prepared.submission, "an answer is a submission");
  const updated = prepared.submission.updated;
  assert.match(updated.conversation.at(-1).content, /情绪不畅时胀痛明显加重/);
  assert.equal(updated.conversation.filter((item) => item.role === "user").length, 1);
  assert.equal(updated.questionOutcome, "answered");
  assert.equal(updated.questionRounds, Math.min(caseState.maxQuestionRounds, caseState.questionRounds + 1));
  assert.equal(client.buildQuestionAnswerSubmission(caseState, draft, {}, "", false).submission, undefined, "nothing to submit");
});

check("warm-up and both submit branches send the same facts fingerprint text", () => {
  const { updated } = client.buildQuestionAnswerSubmission(caseState, draft, selections, "", false).submission;
  const warm = client.withSafetyGateAndOperationalCompleteness(updated);
  const needsInformationBranch = client.withSafetyGateAndOperationalCompleteness(updated);
  const reassessBranch = client.withSafetyGateAndOperationalCompleteness(client.clearDownstreamClinicalResults({
    ...updated, previousResult: client.capturePreviousResult(updated),
  }));
  assert.ok(fingerprintText(warm).includes("情绪不畅时胀痛明显加重"), "the answer is part of the fingerprinted text");
  assert.equal(fingerprintText(needsInformationBranch), fingerprintText(warm));
  assert.equal(fingerprintText(reassessBranch), fingerprintText(warm));
  // 反例：多敲一个字就是另一份病历（不命中，照常抽取）。
  const other = client.buildQuestionAnswerSubmission(caseState, draft, selections, "另：夜间痛醒", false).submission.updated;
  assert.notEqual(fingerprintText(client.withSafetyGateAndOperationalCompleteness(other)), fingerprintText(warm));
});

check("submit, warm-up and the red-flags route are wired to the same builder and the prefetch", () => {
  const source = readFileSync(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/buildQuestionAnswerSubmission\(caseState, recordDraft, selectedQuestionOptions/g) || []).length, 2,
    "handleSubmit and the warm-up effect call the same builder");
  assert.equal((source.match(/const submissionSelections = applyTypedQuestionDetails\(selectedQuestionOptions\);/g) || []).length, 1,
    "the submission construction exists once (inside the shared builder), not as a second inline copy");
  const warmup = source.slice(source.indexOf("const factsWarmupRef"), source.indexOf("QUESTION_FACTS_WARMUP_DEBOUNCE_MS);"));
  assert.match(warmup, /apiUrl\("\/api\/diagnosis\/red-flags\?prefetch=diagnose"\)/);
  assert.doesNotMatch(warmup, /signal:/, "the warm-up must not be aborted by the next run scope");
  const route = readFileSync(new URL("../src/app/api/diagnosis/red-flags/route.ts", import.meta.url), "utf8");
  assert.match(route, /searchParams\.get\("prefetch"\) === "diagnose"\) prefetchDiagnoseInputs\(parsed\.caseState\)/);
});

console.log(JSON.stringify({ suite: "question-facts-warmup", checks, failures }, null, 1));
assert.equal(failures.length, 0);
