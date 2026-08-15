import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TCMEVAL_SDT_SOURCE_FILES,
  aggregateTcmEvalResults,
  buildTcmEvalCaseState,
  consumeTcmEvalNdjson,
  evaluateTcmEvalRecord,
  loadTcmEvalRecords,
  normalizeTcmEvalText,
  optionLettersFromPrediction,
  parseTcmEvalOptions,
  parseTcmEvalReasoning,
  parseTcmEvalResultRows,
  scoreTcmEvalClinicalInformation,
  scoreTcmEvalOptions,
  tcmEvalRougeL,
} from "./lib/tcmeval-sdt.mjs";

assert.equal(TCMEVAL_SDT_SOURCE_FILES.length, 5);
assert.ok(TCMEVAL_SDT_SOURCE_FILES.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
assert.deepEqual(parseTcmEvalOptions("A:肝郁;B:血热不固;J:热伤肺络"), {
  A: "肝郁", B: "血热不固", J: "热伤肺络",
});
assert.equal(normalizeTcmEvalText("血热妄行证。"), "血热妄行");

const goldRows = parseTcmEvalResultRows("\uFEFF病例1@鼻流血;口渴鼻干@H;J@B;I@临证体会：血热。辨证：血热妄行\n");
assert.equal(goldRows.size, 1);
assert.deepEqual(goldRows.get("病例1").pathogenesisAnswers, ["H", "J"]);

const clinicalData = "男性，38岁。主诉及病史：鼻流血15天，口渴鼻干，大便干。诊查：脉浮大数，舌质红，苔薄白。";
const state = buildTcmEvalCaseState({ id: "病例1", clinicalData });
assert.equal(state.patient.sex, "男");
assert.equal(state.patient.age, 38);
assert.match(state.tongue, /舌质红/);
assert.match(state.pulse, /脉浮大数/);
assert.match(state.hisRecord.rawText, /鼻流血15天/);
assert.doesNotMatch(JSON.stringify(state), /Options|Answers|Explanatory Summary|血热妄行/,
  "生产请求适配器不得携带选项或金标准");

const reasoning = {
  stage: "diagnose",
  overview: {
    primarySyndrome: "热伤阳络证，血热妄行证",
    primarySyndromeBasis: ["鼻流血", "口渴鼻干"],
    overallPathogenesis: "热伤肺络，血热不固",
    tcmDiagnosticRationale: "临证体会：热伤肺络，血热不固",
  },
  pathogenesis: {
    summary: "热伤肺络，血热不固",
    symptomClusters: [{ symptoms: ["胸闷气逆"], mechanism: "热伤肺络" }],
    chain: [
      { patientFact: "鼻流血", syndromeEvidence: "口渴鼻干", pathogenesis: "血热不固" },
      { patientFact: "大便干", syndromeEvidence: "口渴鼻干", pathogenesis: "热伤肺络" },
    ],
  },
};
const record = {
  id: "病例1",
  split: "train",
  clinicalData,
  clinicalInformation: ["鼻流血", "口渴鼻干"],
  pathogenesisOptions: { H: "血热不固", I: "水饮内停", J: "热伤肺络" },
  pathogenesisAnswers: ["H", "J"],
  syndromeOptions: { B: "血热妄行", I: "热伤阳络", J: "痰湿内蕴" },
  syndromeAnswers: ["B", "I"],
  explanatorySummary: "临证体会：热伤肺络，血热不固。热伤肺络，血热不固。辨证：热伤阳络证，血热妄行证",
};
const score = evaluateTcmEvalRecord(record, reasoning);
assert.equal(score.tasks.clinicalInformation, 1);
assert.ok(score.prediction.clinicalInformation.includes("胸闷气逆"));
assert.deepEqual(score.prediction.pathogenesisAnswers, ["H", "J"]);
assert.deepEqual(score.prediction.syndromeAnswers, ["B", "I"]);
assert.equal(score.tasks.pathogenesis, 1);
assert.equal(score.tasks.syndrome, 1);
assert.equal(score.tasks.explanatorySummary, 1);
assert.equal(score.weighted, 1);

assert.equal(scoreTcmEvalClinicalInformation(["鼻流血15天"], ["鼻流血"]), 0,
  "Task 1 官方口径必须保留精确匹配，不能静默换成模糊匹配");
assert.equal(scoreTcmEvalOptions(["H", "I"], ["H", "J"]), 1 / 3,
  "Task 2/3 必须按 |A∩B|/(|A|+|Ā∩B|) 惩罚误选");
assert.deepEqual(optionLettersFromPrediction({ A: "肝郁", B: "血热妄行" }, ["血热妄行证"]), ["B"]);
assert.equal(tcmEvalRougeL("完全一致", "完全一致"), 1);
assert.equal(tcmEvalRougeL("", "任意"), 0);

const contract = JSON.stringify(reasoning);
const stream = consumeTcmEvalNdjson([
  JSON.stringify({ content: "旧内容" }),
  JSON.stringify({ content: `<<<CDSS_STREAM_FINAL>>>最终正文\n<!-- DIAGNOSIS_JSON_START -->\n${contract}\n<!-- DIAGNOSIS_JSON_END -->` }),
  JSON.stringify({ content: "[END]" }),
].join("\n"));
assert.equal(stream.sawEnd, true);
assert.doesNotMatch(stream.content, /旧内容/);
assert.deepEqual(parseTcmEvalReasoning(stream.content), reasoning);

function datasetRow(id, labelled) {
  return {
    "Medical Record ID": id,
    "Clinical Data": clinicalData,
    "Clinical Information": labelled ? "鼻流血;口渴鼻干" : "",
    "Options of TCM Pathogenesis": "H:血热不固;J:热伤肺络",
    "Answers of TCM Pathogenesis": labelled ? "H;J" : "",
    "Options of TCM Syndrome": "B:血热妄行;I:热伤阳络",
    "Answers of TCM Syndrome": labelled ? "B;I" : "",
    "Explanatory Summary": labelled ? "临证体会：热伤肺络。辨证：血热妄行" : "",
  };
}
const train = Array.from({ length: 200 }, (_, index) => datasetRow(`训练${index}`, true));
const test = Array.from({ length: 50 }, (_, index) => datasetRow(`测试${index}`, false));
const validation = Array.from({ length: 50 }, (_, index) => datasetRow(`验证${index}`, false));
const resultText = (prefix) => Array.from({ length: 50 }, (_, index) =>
  `${prefix}${index}@鼻流血;口渴鼻干@H;J@B;I@临证体会：热伤肺络。辨证：血热妄行`).join("\n");
const records = loadTcmEvalRecords({
  train: JSON.stringify(train),
  test: JSON.stringify(test),
  validation: JSON.stringify(validation),
  testResults: resultText("测试"),
  validationResults: resultText("验证"),
});
assert.equal(records.length, 300);
assert.deepEqual(records.reduce((acc, item) => ({ ...acc, [item.split]: (acc[item.split] || 0) + 1 }), {}), {
  train: 200, test: 50, validation: 50,
});

const summary = aggregateTcmEvalResults([
  {
    split: "train",
    gate: { status: "ready", completeness: "C" },
    stage: { status: 200, contract: true, ms: 100_000 },
    reasoning: { clinicalReview: { status: "accepted" }, overview: { primarySyndromeResolution: "bounded" } },
    score,
  },
  {
    split: "test",
    gate: { status: "red_flag" },
    stage: { status: 200, contract: false, ms: 200_000 },
    score: evaluateTcmEvalRecord(record, null),
  },
]);
assert.equal(summary.total, 2);
assert.equal(summary.contractFailures, 1);
assert.equal(summary.officialWeightedRaw, 1);
assert.equal(summary.officialWeightedPercent, 50);
assert.deepEqual(summary.gateStatuses, { ready: 1, red_flag: 1 });
assert.deepEqual(summary.completenessLevels, { C: 1, unknown: 1 });
assert.deepEqual(summary.clinicalReviewStatuses, { accepted: 1, unavailable: 1 });
assert.deepEqual(summary.syndromeResolutions, { bounded: 1, unavailable: 1 });
assert.equal(summary.zeroRates.pathogenesis, 0.5);
assert.deepEqual(summary.weightedDistribution, { min: 0, p25: 0, median: 0, p75: 0, max: 1 });
assert.equal(summary.byGate.ready.weightedMean, 1);
assert.equal(summary.byGate.red_flag.weightedMean, 0);
assert.equal(summary.byClinicalReviewStatus.unavailable.weightedMean, 0);
assert.equal(summary.bySyndromeResolution.bounded.weightedMean, 1);
assert.deepEqual(summary.stageLatencyMs, {
  measured: 2, mean: 150000, min: 100000, p25: 100000, median: 100000,
  p75: 100000, p95: 100000, max: 200000, over180Seconds: 1,
});

const liveSource = readFileSync(new URL("./regress-tcmeval-sdt-live.mjs", import.meta.url), "utf8");
assert.match(liveSource, /body: JSON\.stringify\(\{ caseState \}\)/,
  "线上评测请求只能发送 caseState");
assert.doesNotMatch(liveSource.slice(liveSource.indexOf("async function postDiagnose"), liveSource.indexOf("function retryableAttempt")),
  /pathogenesisOptions|syndromeOptions|pathogenesisAnswers|syndromeAnswers|explanatorySummary/,
  "线上请求函数不得读取选项或金标准");
assert.match(liveSource, /const pending = SUMMARY_ONLY\s*\? \[\]/,
  "只汇总模式必须禁止任何待运行病例进入模型 worker");

console.log(JSON.stringify({ suite: "tcmeval-sdt", cases: 70, failures: 0 }));
