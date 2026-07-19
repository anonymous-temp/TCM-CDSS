import assert from "node:assert/strict";

const {
  canProceedToM03AfterFollowup,
  hardDoseSafetyBoundaryReasons,
  hasHardDoseSafetyBoundary,
  withSafetyGate,
} = await import("../src/lib/diagnosis-safety.ts");
const { createInitialCaseState, normalizeCaseStateInput } = await import("../src/lib/diagnosis-types.ts");

function state(fields, questionRounds = 1) {
  const base = createInitialCaseState();
  const chiefComplaint = Object.hasOwn(fields, "zhushu") ? fields.zhushu : "夜间汗出反复1月";
  return withSafetyGate({
    ...base,
    phase: "question",
    chiefComplaint,
    questionRounds,
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1",
      source: "test",
      caseId: base.id,
      updatedAt: new Date(0).toISOString(),
      fields: { zhushu: chiefComplaint, ...fields },
      rawText: Object.values(fields).join("；"),
    },
  });
}

assert.equal(
  canProceedToM03AfterFollowup(state({ tcmDetail: "寒热汗出已核实，无明显恶寒发热、潮热、自汗或盗汗" }, 0)),
  true,
  "a chief complaint can enter M03 even before an optional follow-up",
);
assert.equal(
  canProceedToM03AfterFollowup(state({ tcmDetail: "寒热汗出已核实，无明显恶寒发热、潮热、自汗或盗汗" })),
  true,
  "the screenshot flow proceeds to M03 after one confirmed observable fact",
);
assert.equal(
  canProceedToM03AfterFollowup(state({ xianbingshi: "劳倦后出现，持续1月，休息后减轻" })),
  true,
  "a patient-specific course/trigger answer unlocks M03 without requiring a model-derived pathogenesis",
);
assert.equal(
  canProceedToM03AfterFollowup(state({ sex: "男", guomin: "否认药物过敏", yongyaoshi: "否认当前用药" })),
  true,
  "optional demographic and medication-safety fields never become an M03 entry gate",
);
assert.equal(
  canProceedToM03AfterFollowup(state({ zhushu: "" })),
  false,
  "M03 still requires a clinical target",
);

const legacyMultiRound = normalizeCaseStateInput({
  ...createInitialCaseState({ maxQuestionRounds: 3 }),
  maxQuestionRounds: 3,
});
assert.equal(legacyMultiRound?.maxQuestionRounds, 1, "restored or external cases must stay on the one-question M02 contract");

assert.equal(
  hasHardDoseSafetyBoundary(state({ sex: "男", age: "45岁", guomin: "不详", yongyaoshi: "不详" })),
  false,
  "unknown optional safety fields must not turn a sparse ordinary adult case into a hard dose boundary",
);

const pediatric = state({ sex: "男", age: "8岁", weight: "25kg" });
assert.equal(hasHardDoseSafetyBoundary(pediatric), true, "a pediatric case must not enter the ordinary adult dose chain");
assert.match(hardDoseSafetyBoundaryReasons(pediatric).join("；"), /儿童/);

const pregnant = state({ sex: "女", age: "32岁", xianbingshi: "已确认妊娠12周，近期入睡困难" });
assert.equal(hasHardDoseSafetyBoundary(pregnant), true, "explicit pregnancy must not enter the ordinary adult dose chain");
assert.match(hardDoseSafetyBoundaryReasons(pregnant).join("；"), /妊娠/);

console.log(JSON.stringify({ cases: 9, failures: 0 }));
