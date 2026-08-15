import { createHash } from "node:crypto";

export const TCMEVAL_SDT_SOURCE_COMMIT = "12473b50ce94ad2fd22b1e984b826b0a618c4407";

export const TCMEVAL_SDT_SOURCE_FILES = Object.freeze([
  {
    key: "train",
    name: "Train_TCM_Data_v1.json",
    path: "evaluation/TCMEval-SDT/data/Train_TCM_Data_v1.json",
    sha256: "cddcf9c7187d43462b8c80b1756527e506b2e8d9d0329171d50477f49bd679cd",
  },
  {
    key: "test",
    name: "Test_TCM_Data_v1.json",
    path: "evaluation/TCMEval-SDT/data/Test_TCM_Data_v1.json",
    sha256: "4b9f69308b46125ea6d979613d4b2717b1d930d7acefd2e3c58d274975420bff",
  },
  {
    key: "validation",
    name: "Validation_TCM_Data_v1.json",
    path: "evaluation/TCMEval-SDT/data/Validation_TCM_Data_v1.json",
    sha256: "80b5b836349da9c0c3f9be31255c8baad5669a4b33270778ce67f71187fe1e6c",
  },
  {
    key: "testResults",
    name: "Test_data_result.txt",
    path: "evaluation/TCMEval-SDT/Results/Test_data_result.txt",
    sha256: "68b521be0650796af8fcc96672b680368278b561c07203b03d10d1ef78530ee5",
  },
  {
    key: "validationResults",
    name: "Validation_data_result.txt",
    path: "evaluation/TCMEval-SDT/Results/Validation_data_result.txt",
    sha256: "427de6e639addde75a05be08e99063df2bdfd8fbac9cb53b0d3bc339e642113a",
  },
]);

export const TCMEVAL_SDT_WEIGHTS = Object.freeze({
  clinicalInformation: 0.2,
  pathogenesis: 0.3,
  syndrome: 0.4,
  explanatorySummary: 0.1,
});

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeTcmEvalText(value) {
  return stringValue(value)
    .normalize("NFKC")
    .replace(/[\s\u3000]/g, "")
    .replace(/[，,。；;：:、（）()《》“”‘’"'·—–\-~～！？!?]/g, "")
    .replace(/证$/u, "")
    .toLowerCase();
}

export function splitTcmEvalTerms(value) {
  return [...new Set(
    stringValue(value)
      .split(/[;；\n]/)
      .map((item) => item.trim().replace(/^[\-•·\d.、）)\s]+/u, ""))
      .filter(Boolean),
  )];
}

export function parseTcmEvalOptions(value) {
  const text = stringValue(value).replace(/；/g, ";");
  const matches = [...text.matchAll(/(?:^|;)([A-J])\s*[:：]\s*([^;]+)/g)];
  return Object.fromEntries(matches.map((match) => [match[1], match[2].trim()]));
}

export function parseTcmEvalAnswerLetters(value) {
  return [...new Set(
    stringValue(value)
      .toUpperCase()
      .split(/[;；,，\s]+/)
      .map((item) => item.trim())
      .filter((item) => /^[A-J]$/.test(item)),
  )].sort();
}

export function parseTcmEvalResultRows(value) {
  const rows = stringValue(value).replace(/^\uFEFF/u, "").split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  const parsed = new Map();
  for (const row of rows) {
    const parts = row.split("@");
    if (parts.length < 5) throw new Error(`TCMEval-SDT 标准结果行字段不足：${row.slice(0, 80)}`);
    const id = parts[0].replace(/^\uFEFF/u, "").trim();
    if (!id || parsed.has(id)) throw new Error(`TCMEval-SDT 标准结果 ID 重复或为空：${id || "<empty>"}`);
    parsed.set(id, {
      clinicalInformation: splitTcmEvalTerms(parts[1]),
      pathogenesisAnswers: parseTcmEvalAnswerLetters(parts[2]),
      syndromeAnswers: parseTcmEvalAnswerLetters(parts[3]),
      explanatorySummary: parts.slice(4).join("@").trim(),
    });
  }
  return parsed;
}

function recordFromJson(row, split, resultRows) {
  const id = stringValue(row?.["Medical Record ID"]).replace(/^\uFEFF/u, "");
  const supplemental = resultRows?.get(id);
  const record = {
    id,
    split,
    clinicalData: stringValue(row?.["Clinical Data"]),
    clinicalInformation: splitTcmEvalTerms(row?.["Clinical Information"] || supplemental?.clinicalInformation?.join(";")),
    pathogenesisOptions: parseTcmEvalOptions(row?.["Options of TCM Pathogenesis"]),
    pathogenesisAnswers: parseTcmEvalAnswerLetters(row?.["Answers of TCM Pathogenesis"] || supplemental?.pathogenesisAnswers?.join(";")),
    syndromeOptions: parseTcmEvalOptions(row?.["Options of TCM Syndrome"]),
    syndromeAnswers: parseTcmEvalAnswerLetters(row?.["Answers of TCM Syndrome"] || supplemental?.syndromeAnswers?.join(";")),
    explanatorySummary: stringValue(row?.["Explanatory Summary"] || supplemental?.explanatorySummary),
  };
  if (!record.id || !record.clinicalData) throw new Error(`TCMEval-SDT ${split} 存在空 ID 或空病历`);
  if (record.clinicalInformation.length === 0 || record.pathogenesisAnswers.length === 0 ||
      record.syndromeAnswers.length === 0 || !record.explanatorySummary) {
    throw new Error(`TCMEval-SDT ${split}/${record.id} 缺少四任务金标准`);
  }
  return record;
}

export function loadTcmEvalRecords({ train, test, validation, testResults, validationResults }) {
  const trainRows = JSON.parse(train);
  const testRows = JSON.parse(test);
  const validationRows = JSON.parse(validation);
  const testGold = parseTcmEvalResultRows(testResults);
  const validationGold = parseTcmEvalResultRows(validationResults);
  if (!Array.isArray(trainRows) || trainRows.length !== 200) throw new Error("TCMEval-SDT train 必须为 200 例");
  if (!Array.isArray(testRows) || testRows.length !== 50) throw new Error("TCMEval-SDT test 必须为 50 例");
  if (!Array.isArray(validationRows) || validationRows.length !== 50) throw new Error("TCMEval-SDT validation 必须为 50 例");
  if (testGold.size !== 50 || validationGold.size !== 50) throw new Error("TCMEval-SDT Results 金标准必须各为 50 例");

  const records = [
    ...trainRows.map((row) => recordFromJson(row, "train")),
    ...testRows.map((row) => recordFromJson(row, "test", testGold)),
    ...validationRows.map((row) => recordFromJson(row, "validation", validationGold)),
  ];
  const ids = new Set(records.map((record) => record.id));
  if (ids.size !== 300) throw new Error(`TCMEval-SDT 病例 ID 必须全局唯一：实际 ${ids.size}/300`);
  return records;
}

function extractSection(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  if (start < 0) return "";
  const afterStart = text.slice(start).replace(startPattern, "");
  const end = afterStart.search(endPattern);
  return (end < 0 ? afterStart : afterStart.slice(0, end)).trim();
}

function clinicalClauses(text, pattern) {
  return [...new Set(
    stringValue(text)
      .split(/[。；;]/)
      .map((item) => item.trim())
      .filter((item) => item && pattern.test(item)),
  )].join("；");
}

function demographicProjection(clinicalData) {
  const text = stringValue(clinicalData).slice(0, 80);
  const sex = /(?:女性|女童|女孩|女婴|患者女性|氏妇)/.test(text)
    ? "女"
    : /(?:男性|男童|男孩|男婴|患者男性)/.test(text)
      ? "男"
      : "";
  const yearMatch = text.match(/(\d{1,3})\s*岁(?:零\s*(\d{1,2})\s*个月|半)?/);
  const monthMatch = text.match(/(?<!岁)(\d{1,2})\s*个月/);
  let age;
  if (yearMatch) age = Number(yearMatch[1]) + (yearMatch[2] ? Number(yearMatch[2]) / 12 : /岁半/.test(yearMatch[0]) ? 0.5 : 0);
  else if (monthMatch) age = Number(monthMatch[1]) / 12;
  return { sex, age: Number.isFinite(age) && age > 0 ? age : undefined };
}

export function buildTcmEvalCaseState(record) {
  const clinicalData = stringValue(record?.clinicalData);
  const patient = demographicProjection(clinicalData);
  const history = extractSection(
    clinicalData,
    /^(?:.*?)(?:主诉(?:\([^)]*\))?(?:及病史)?|病史)\s*[：:]/u,
    /(?:诊查|查体|体检)\s*[：:]/u,
  ) || clinicalData;
  const examination = extractSection(
    clinicalData,
    /^(?:.*?)(?:诊查|查体|体检)\s*[：:]/u,
    /$^/u,
  );
  const tongue = clinicalClauses(examination || clinicalData, /舌|苔/u);
  const pulse = clinicalClauses(examination || clinicalData, /脉|指纹/u);
  const labs = clinicalClauses(clinicalData, /(?:化验|检查|血压|体温|心率|心电图|超声|X线|CT|MRI|血色素|白细胞|尿素氮)/iu);
  const chiefComplaint = history.split(/[。；;]/).map((item) => item.trim()).find(Boolean) || clinicalData.slice(0, 160);
  const idSuffix = record.id.replace(/[^\p{L}\p{N}_-]/gu, "_");
  const fields = {
    zhushu: chiefComplaint,
    sex: patient.sex,
    age: patient.age == null ? "" : String(Number(patient.age.toFixed(2))),
    xianbingshi: history,
    jiwangshi: "",
    guomin: "",
    yongyaoshi: "",
    tcmTongue: tongue,
    tcmPulse: pulse,
    tcmDetail: examination,
    jiancha: labs,
    vitalsT: "",
    vitalsP: "",
    vitalsR: "",
    vitalsBP: "",
    tcmLineagePreference: "unrestricted",
  };
  return {
    id: `tcmeval_sdt_${idSuffix}`,
    phase: "diagnose",
    patient: { sex: patient.sex, ...(patient.age == null ? {} : { age: patient.age }) },
    chiefComplaint,
    symptoms: { general: history, tcmFourExams: examination },
    tongue,
    pulse,
    vitals: "",
    labs,
    pastHistory: "",
    medicationHistory: "",
    allergyHistory: "",
    tcmLineagePreference: "unrestricted",
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1",
      source: "tcm-cdss-his",
      caseId: `tcmeval_sdt_${idSuffix}`,
      updatedAt: "2025-03-13T00:00:00.000Z",
      tongueImageUploaded: false,
      fields,
      rawText: clinicalData,
    },
    questionRounds: 1,
    maxQuestionRounds: 1,
    conversation: [],
    diagnosis: "",
    prescription: "",
    riskAssessment: "",
  };
}

export function consumeTcmEvalNdjson(raw) {
  let content = "";
  let errorFrame = "";
  let sawEnd = false;
  let frames = 0;
  for (const line of stringValue(raw).split("\n").filter(Boolean)) {
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    frames += 1;
    if (typeof frame.error === "string") errorFrame = frame.error;
    if (typeof frame.content !== "string") continue;
    if (frame.content === "[END]") {
      sawEnd = true;
      continue;
    }
    content = frame.content.startsWith(REPLACE_MARKER)
      ? frame.content.slice(REPLACE_MARKER.length)
      : content + frame.content;
  }
  return { content, errorFrame, sawEnd, frames };
}

export function parseTcmEvalReasoning(content) {
  const start = stringValue(content).lastIndexOf(START);
  const end = start >= 0 ? content.indexOf(END, start) : -1;
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(content.slice(start + START.length, end).trim()); } catch { return null; }
}

export function tcmEvalVisibleContent(content) {
  const start = stringValue(content).lastIndexOf(START);
  return start < 0 ? stringValue(content) : content.slice(0, start).trim();
}

function addAtomicFacts(target, value) {
  for (const item of Array.isArray(value) ? value : [value]) {
    const text = stringValue(item);
    if (!text) continue;
    target.add(text);
    for (const clause of text.split(/[；;，,]/).map((entry) => entry.trim()).filter((entry) => entry.length >= 2)) {
      target.add(clause);
    }
  }
}

function predictionText(reasoning, paths) {
  const values = [];
  for (const path of paths) {
    let current = reasoning;
    for (const segment of path.split(".")) current = current?.[segment];
    if (Array.isArray(current)) values.push(...current.map(stringValue).filter(Boolean));
    else if (stringValue(current)) values.push(stringValue(current));
  }
  return values;
}

export function predictionsFromTcmEvalReasoning(reasoning) {
  if (!reasoning || typeof reasoning !== "object") {
    return { clinicalInformation: [], pathogenesisTexts: [], syndromeTexts: [], explanatorySummary: "" };
  }
  const facts = new Set();
  addAtomicFacts(facts, reasoning.overview?.primarySyndromeBasis);
  for (const node of Array.isArray(reasoning.pathogenesis?.chain) ? reasoning.pathogenesis.chain : []) {
    addAtomicFacts(facts, node?.patientFact);
    addAtomicFacts(facts, node?.syndromeEvidence);
  }
  for (const cluster of Array.isArray(reasoning.pathogenesis?.symptomClusters) ? reasoning.pathogenesis.symptomClusters : []) {
    addAtomicFacts(facts, cluster?.symptoms);
  }
  const pathogenesisTexts = [
    ...predictionText(reasoning, ["overview.overallPathogenesis", "pathogenesis.summary"]),
    ...(Array.isArray(reasoning.pathogenesis?.chain)
      ? reasoning.pathogenesis.chain.map((node) => stringValue(node?.pathogenesis)).filter(Boolean)
      : []),
    ...(Array.isArray(reasoning.pathogenesis?.symptomClusters)
      ? reasoning.pathogenesis.symptomClusters.map((cluster) => stringValue(cluster?.mechanism)).filter(Boolean)
      : []),
  ];
  const syndromeTexts = predictionText(reasoning, ["overview.primarySyndrome"]);
  const summaryParts = [
    stringValue(reasoning.overview?.tcmDiagnosticRationale),
    stringValue(reasoning.pathogenesis?.summary),
    stringValue(reasoning.overview?.overallPathogenesis),
    syndromeTexts[0] ? `辨证：${syndromeTexts[0]}` : "",
  ].filter(Boolean);
  return {
    clinicalInformation: [...facts],
    pathogenesisTexts: [...new Set(pathogenesisTexts)],
    syndromeTexts: [...new Set(syndromeTexts)],
    explanatorySummary: [...new Set(summaryParts)].join("。"),
  };
}

export function optionLettersFromPrediction(options, predictionTexts) {
  const normalizedPredictions = (predictionTexts || []).map(normalizeTcmEvalText).filter(Boolean);
  return Object.entries(options || {})
    .filter(([, label]) => {
      const normalizedLabel = normalizeTcmEvalText(label);
      if (normalizedLabel.length < 2) return false;
      return normalizedPredictions.some((prediction) =>
        prediction === normalizedLabel || prediction.includes(normalizedLabel) ||
        (prediction.length >= 2 && normalizedLabel.includes(prediction)));
    })
    .map(([letter]) => letter)
    .sort();
}

export function scoreTcmEvalClinicalInformation(predicted, expected) {
  const predictedSet = new Set((predicted || []).map(stringValue).filter(Boolean));
  if (!(expected || []).length) return 0;
  return expected.filter((item) => predictedSet.has(stringValue(item))).length / expected.length;
}

export function scoreTcmEvalClinicalContainment(predicted, expected) {
  const normalizedPredictions = (predicted || []).map(normalizeTcmEvalText).filter(Boolean);
  if (!(expected || []).length) return 0;
  const matched = expected.filter((item) => {
    const target = normalizeTcmEvalText(item);
    return target.length >= 2 && normalizedPredictions.some((prediction) =>
      prediction === target || prediction.includes(target) ||
      (prediction.length >= 3 && target.includes(prediction)));
  }).length;
  return matched / expected.length;
}

export function scoreTcmEvalOptions(predicted, expected) {
  const predictedSet = new Set(predicted || []);
  const expectedSet = new Set(expected || []);
  const correct = [...predictedSet].filter((item) => expectedSet.has(item)).length;
  const wrong = [...predictedSet].filter((item) => !expectedSet.has(item)).length;
  const denominator = expectedSet.size + wrong;
  return denominator === 0 ? 0 : correct / denominator;
}

export function tcmEvalRougeL(reference, prediction, beta = 1) {
  const left = stringValue(reference);
  const right = stringValue(prediction);
  if (!left || !right) return 0;
  const previous = new Uint32Array(right.length + 1);
  const current = new Uint32Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    previous.set(current);
    current.fill(0);
  }
  const lcs = previous[right.length];
  if (!lcs) return 0;
  const recall = lcs / left.length;
  const precision = lcs / right.length;
  return ((1 + beta ** 2) * recall * precision) / (recall + beta ** 2 * precision);
}

export function evaluateTcmEvalRecord(record, reasoning) {
  const prediction = predictionsFromTcmEvalReasoning(reasoning);
  const pathogenesisAnswers = optionLettersFromPrediction(record.pathogenesisOptions, prediction.pathogenesisTexts);
  const syndromeAnswers = optionLettersFromPrediction(record.syndromeOptions, prediction.syndromeTexts);
  const tasks = {
    clinicalInformation: scoreTcmEvalClinicalInformation(prediction.clinicalInformation, record.clinicalInformation),
    clinicalInformationContainment: scoreTcmEvalClinicalContainment(prediction.clinicalInformation, record.clinicalInformation),
    pathogenesis: scoreTcmEvalOptions(pathogenesisAnswers, record.pathogenesisAnswers),
    syndrome: scoreTcmEvalOptions(syndromeAnswers, record.syndromeAnswers),
    explanatorySummary: tcmEvalRougeL(record.explanatorySummary, prediction.explanatorySummary),
  };
  const weighted = TCMEVAL_SDT_WEIGHTS.clinicalInformation * tasks.clinicalInformation +
    TCMEVAL_SDT_WEIGHTS.pathogenesis * tasks.pathogenesis +
    TCMEVAL_SDT_WEIGHTS.syndrome * tasks.syndrome +
    TCMEVAL_SDT_WEIGHTS.explanatorySummary * tasks.explanatorySummary;
  return {
    prediction: { ...prediction, pathogenesisAnswers, syndromeAnswers },
    expected: {
      clinicalInformation: record.clinicalInformation,
      pathogenesisAnswers: record.pathogenesisAnswers,
      syndromeAnswers: record.syndromeAnswers,
      explanatorySummary: record.explanatorySummary,
    },
    tasks,
    weighted,
  };
}

function rounded(value, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

export function aggregateTcmEvalResults(results) {
  const total = results.length;
  const scored = results.filter((item) => item.score && !item.harnessError);
  const sum = (key) => scored.reduce((acc, item) => acc + Number(item.score.tasks?.[key] || 0), 0);
  const weightedRaw = scored.reduce((acc, item) => acc + Number(item.score.weighted || 0), 0);
  const taskKeys = ["clinicalInformation", "clinicalInformationContainment", "pathogenesis", "syndrome", "explanatorySummary"];
  const metricProjection = (items) => {
    const denominator = items.length || 1;
    return {
      weightedMean: rounded(items.reduce((acc, item) => acc + Number(item.score?.weighted || 0), 0) / denominator),
      tasks: Object.fromEntries(taskKeys.map((key) => [
        key,
        rounded(items.reduce((acc, item) => acc + Number(item.score?.tasks?.[key] || 0), 0) / denominator),
      ])),
    };
  };
  const bySplit = {};
  const byGate = {};
  const byClinicalReviewStatus = {};
  const bySyndromeResolution = {};
  const gateStatuses = {};
  const completenessLevels = {};
  const clinicalReviewStatuses = {};
  const syndromeResolutions = {};
  for (const item of results) {
    const split = item.split || "unknown";
    bySplit[split] ||= { total: 0, scored: 0, weightedRaw: 0 };
    bySplit[split].total += 1;
    if (item.score && !item.harnessError) {
      bySplit[split].scored += 1;
      bySplit[split].weightedRaw += Number(item.score.weighted || 0);
    }
    const status = item.gate?.status || "unknown";
    gateStatuses[status] = (gateStatuses[status] || 0) + 1;
    byGate[status] ||= [];
    byGate[status].push(item);
    const completeness = item.gate?.completeness || "unknown";
    completenessLevels[completeness] = (completenessLevels[completeness] || 0) + 1;
    const reviewStatus = item.reasoning?.clinicalReview?.status || "unavailable";
    clinicalReviewStatuses[reviewStatus] = (clinicalReviewStatuses[reviewStatus] || 0) + 1;
    byClinicalReviewStatus[reviewStatus] ||= [];
    byClinicalReviewStatus[reviewStatus].push(item);
    const syndromeResolution = item.reasoning?.overview?.primarySyndromeResolution || "unavailable";
    syndromeResolutions[syndromeResolution] = (syndromeResolutions[syndromeResolution] || 0) + 1;
    bySyndromeResolution[syndromeResolution] ||= [];
    bySyndromeResolution[syndromeResolution].push(item);
  }
  for (const split of Object.values(bySplit)) {
    split.weightedRaw = rounded(split.weightedRaw);
    split.weightedPercent = split.total ? rounded(100 * split.weightedRaw / split.total, 3) : 0;
  }
  const weightedValues = scored.map((item) => Number(item.score.weighted || 0)).sort((left, right) => left - right);
  const percentile = (fraction) => weightedValues.length
    ? weightedValues[Math.min(weightedValues.length - 1, Math.floor((weightedValues.length - 1) * fraction))]
    : 0;
  const latencyValues = results
    .map((item) => Number(item.stage?.ms || 0))
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const latencyPercentile = (fraction) => latencyValues.length
    ? latencyValues[Math.min(latencyValues.length - 1, Math.floor((latencyValues.length - 1) * fraction))]
    : 0;
  return {
    total,
    scored: scored.length,
    harnessErrors: results.filter((item) => item.harnessError).length,
    httpFailures: results.filter((item) => item.stage && item.stage.status !== 200).length,
    contractFailures: results.filter((item) => item.stage?.status === 200 && !item.stage.contract).length,
    truncated: results.filter((item) => item.stage?.truncated).length,
    gateStatuses,
    completenessLevels,
    clinicalReviewStatuses,
    syndromeResolutions,
    byGate: Object.fromEntries(Object.entries(byGate).map(([status, items]) => [status, {
      total: items.length,
      ...metricProjection(items),
    }])),
    byClinicalReviewStatus: Object.fromEntries(Object.entries(byClinicalReviewStatus).map(([status, items]) => [status, {
      total: items.length,
      ...metricProjection(items),
    }])),
    bySyndromeResolution: Object.fromEntries(Object.entries(bySyndromeResolution).map(([status, items]) => [status, {
      total: items.length,
      ...metricProjection(items),
    }])),
    tasks: {
      clinicalInformation: total ? rounded(sum("clinicalInformation") / total) : 0,
      clinicalInformationContainment: total ? rounded(sum("clinicalInformationContainment") / total) : 0,
      pathogenesis: total ? rounded(sum("pathogenesis") / total) : 0,
      syndrome: total ? rounded(sum("syndrome") / total) : 0,
      explanatorySummary: total ? rounded(sum("explanatorySummary") / total) : 0,
    },
    officialWeightedRaw: rounded(weightedRaw),
    officialWeightedMean: total ? rounded(weightedRaw / total) : 0,
    officialWeightedPercent: total ? rounded(100 * weightedRaw / total, 3) : 0,
    zeroRates: Object.fromEntries(
      taskKeys.filter((key) => key !== "clinicalInformationContainment").map((key) => [
        key,
        total ? rounded(results.filter((item) => Number(item.score?.tasks?.[key] || 0) === 0).length / total) : 0,
      ]),
    ),
    weightedDistribution: {
      min: rounded(percentile(0)),
      p25: rounded(percentile(0.25)),
      median: rounded(percentile(0.5)),
      p75: rounded(percentile(0.75)),
      max: rounded(percentile(1)),
    },
    stageLatencyMs: {
      measured: latencyValues.length,
      mean: latencyValues.length
        ? rounded(latencyValues.reduce((acc, value) => acc + value, 0) / latencyValues.length, 0)
        : 0,
      min: rounded(latencyPercentile(0), 0),
      p25: rounded(latencyPercentile(0.25), 0),
      median: rounded(latencyPercentile(0.5), 0),
      p75: rounded(latencyPercentile(0.75), 0),
      p95: rounded(latencyPercentile(0.95), 0),
      max: rounded(latencyPercentile(1), 0),
      over180Seconds: latencyValues.filter((value) => value > 180_000).length,
    },
    bySplit,
  };
}
