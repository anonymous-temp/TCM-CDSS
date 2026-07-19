import assert from "node:assert/strict";

const {
  detectProgrammaticRedFlags,
  deriveOperationalCompleteness,
  evaluateSafetyGate,
  canForceProceedPastSafetyGate,
  sanitizeUngroundedRedFlagNegations,
  sanitizeFreeTextForModel,
  deriveFirstReviewTiming,
  reconcileRestoredCaseState,
  sanitizeCaseStateForModel,
  sanitizeFreeTextForExternalClinicalService,
  buildForcedIncompleteRiskFollowup,
  clinicalGroundingText,
  hardDoseSafetyBoundaryReasons,
  measuredVitalAdvisories,
  withSafetyGate,
} = await import("../src/lib/diagnosis-safety.ts");
const { createInitialCaseState } = await import("../src/lib/diagnosis-types.ts");
const { isUnknownClinicalFieldText, isUnknownClinicalText } = await import("../src/lib/clinical-state.ts");
const { consumeCollectStream, consumeMarkdownStream, sanitizeCaseStateForBrowserPersistence, scrubPersistentPhiText } = await import("../src/lib/diagnosis-engine.ts");
const { computePrescriptionVersionHash } = await import("../src/lib/prescription-version.ts");
const { buildAuditData, buildAuditItemsFromHerbs, buildLingxiRiskSection } = await import("../src/lib/rxaudit.ts");
const { normalizeExternalEvidenceResponse } = await import("../src/lib/evimed-guide.ts");
const { isKnownTcmHerbName } = await import("../src/lib/tcm-knowledge.ts");
const { prescriptionRegimenFromDecoction } = await import("../src/lib/prescription-regimen-contract.ts");
const { buildRxAuditStatusMarker, parseRxAuditStatusMarker, stripRxAuditStatusMarker } = await import("../src/lib/rxaudit-status.ts");
const { buildSeasonalCare, currentSolarTerm } = await import("../src/lib/tcm-seasonal-care.ts");
const { computeTongueRoiCrop, detectTongueRoi } = await import("../src/lib/tongue-image-roi.ts");
const {
  filterModificationsForEditedHerbs,
  hasIncompleteEditedHerb,
  synchronizeEditedCandidate,
} = await import("../src/lib/prescription-revision.ts");

const atomicFallbackState = createInitialCaseState();
atomicFallbackState.chiefComplaint = "入睡困难2周";
atomicFallbackState.symptoms = { sleep: "入睡困难", duration: "2周", nested: { appetite: "纳差" } };
atomicFallbackState.vitals = { temperature: 36.6, pulse: 72 };
const atomicGrounding = clinicalGroundingText(atomicFallbackState);
assert.doesNotMatch(atomicGrounding, /[{}\[\]"]/, "fallback grounding must never expose a serialized symptom DTO as one patient fact");
for (const fact of ["入睡困难", "2周", "纳差", "36.6", "72"]) assert.match(atomicGrounding, new RegExp(fact));

for (const [width, height] of [[3024, 4032], [4032, 3024], [320, 480]]) {
  const crop = computeTongueRoiCrop(width, height);
  assert.ok(crop.x > 0 && crop.y > 0, "tongue upload must crop outer background rather than only resize");
  assert.ok(crop.width < width && crop.height < height);
  assert.ok(crop.x + crop.width <= width && crop.y + crop.height <= height, "ROI remains within source pixels");
  assert.ok(crop.width / width >= 0.75 && crop.height / height >= 0.78, "ROI keeps conservative margins to avoid cutting the tongue");
}

// Content-aware tongue ROI detection (classic-CV heuristic; synthetic ImageData fixtures, no canvas).
function makeSyntheticImageData(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}
const ROI_TONGUE_RED = [186, 78, 92];
const ROI_NEUTRAL_BG = [203, 201, 198];

// (a) Off-center reddish blob on neutral background → detected, and the crop tracks the blob.
{
  const W = 220, H = 180;
  const cx = 140, cy = 105, rx = 44, ry = 38;
  const img = makeSyntheticImageData(W, H, (x, y) =>
    ((x - cx) ** 2) / rx ** 2 + ((y - cy) ** 2) / ry ** 2 <= 1 ? ROI_TONGUE_RED : ROI_NEUTRAL_BG);
  const roi = detectTongueRoi(img);
  assert.equal(roi.method, "detected", "reddish blob on neutral background must be detected");
  assert.ok(roi.confidence > 0);
  const roiCx = roi.x + roi.w / 2;
  const roiCy = roi.y + roi.h / 2;
  assert.ok(Math.abs(roiCx - cx) <= 12 && Math.abs(roiCy - cy) <= 12, `detected ROI center must track the blob (got ${roiCx},${roiCy}, expected near ${cx},${cy})`);
  assert.ok(roi.w >= rx * 2 && roi.h >= ry * 2, "detected ROI keeps the whole blob plus margin");
  assert.ok(roi.x >= 0 && roi.y >= 0 && roi.x + roi.w <= W && roi.y + roi.h <= H, "detected ROI stays within source pixels");
}

// (b) Uniform solid-color frames → fallback-center, exactly the computeTongueRoiCrop result.
//     Solid red trips the ">90% of guided region" gate; solid neutral yields no tissue pixels at all.
for (const solid of [[200, 60, 70], ROI_NEUTRAL_BG]) {
  const img = makeSyntheticImageData(200, 160, () => solid);
  const roi = detectTongueRoi(img);
  assert.equal(roi.method, "fallback-center", `uniform ${solid} frame must fall back to the center crop`);
  assert.equal(roi.confidence, 0);
  const crop = computeTongueRoiCrop(200, 160);
  assert.deepEqual(
    { x: roi.x, y: roi.y, w: roi.w, h: roi.h },
    { x: crop.x, y: crop.y, w: crop.width, h: crop.height },
    "fallback-center must equal computeTongueRoiCrop",
  );
}

// (c) Tiny/degenerate blob → fallback (must not steer the crop).
{
  const img = makeSyntheticImageData(220, 180, (x, y) =>
    x >= 100 && x < 112 && y >= 90 && y < 100 ? ROI_TONGUE_RED : ROI_NEUTRAL_BG);
  const roi = detectTongueRoi(img);
  assert.equal(roi.method, "fallback-center", "a tiny blob must not steer the crop");
}

assert.equal(scrubPersistentPhiText("张三昨夜失眠"), "[姓名已脱敏]昨夜失眠");
assert.equal(scrubPersistentPhiText("患者王小明今日来诊"), "患者[姓名已脱敏]今日来诊");
assert.doesNotMatch(scrubPersistentPhiText("出生日期：1990-02-03，夜间失眠"), /1990|02-03/);
assert.doesNotMatch(sanitizeFreeTextForExternalClinicalService("出生日期：1990年2月3日，患者张三失眠"), /1990|2月3日|张三/);
assert.doesNotMatch(sanitizeFreeTextForExternalClinicalService("张三咳嗽3日", ["张三"]), /张三/);
assert.doesNotMatch(sanitizeFreeTextForExternalClinicalService("Alice Wang 昨夜失眠三周"), /Alice Wang/);
for (const unlabeledAddress of [
  "患者住在上海市浦东新区张江路88号3栋1201室，咳嗽3日",
  "长期居于中山大道1066号2幢，近一周失眠",
]) {
  const scrubbed = sanitizeFreeTextForExternalClinicalService(unlabeledAddress);
  assert.doesNotMatch(scrubbed, /张江路88号|中山大道1066号|1201室/, "unlabeled street/building identifiers must be removed before model egress");
  assert.match(scrubbed, /\[地址已脱敏\]/);
}
assert.doesNotMatch(
  sanitizeFreeTextForExternalClinicalService("就诊时间：2026-07-19T14:23:51+08:00；主诉失眠"),
  /2026-07-19T14:23:51/,
  "exact encounter timestamps are quasi-identifiers",
);
for (const identifier of ["病历号：ABCD1234", "病例号 CASE-5678", "MRN: MRN998877", "患者编号：PT-20260714"]) {
  assert.doesNotMatch(sanitizeFreeTextForExternalClinicalService(`咳嗽3日；${identifier}`), /ABCD1234|CASE-5678|MRN998877|PT-20260714/i, identifier);
}
const unavailableAuditMarker = buildRxAuditStatusMarker({ available: false, reason: "no_prescription_items" });
assert.deepEqual(parseRxAuditStatusMarker(`${unavailableAuditMarker}\n## 合理用药审方`), { available: false, reason: "no_prescription_items" });
assert.equal(stripRxAuditStatusMarker(`${unavailableAuditMarker}\n## 合理用药审方`), "## 合理用药审方");
assert.deepEqual(parseRxAuditStatusMarker(buildRxAuditStatusMarker({ available: true })), { available: true });
assert.equal(currentSolarTerm(new Date("2026-07-14T02:00:00Z")).name, "小暑");
assert.equal(currentSolarTerm(new Date("2026-01-02T02:00:00Z")).name, "冬至");
assert.match(buildSeasonalCare("阴虚火旺夹湿", new Date("2026-07-14T02:00:00Z")).solarTerm, /小暑前后/);
assert.match(buildSeasonalCare("阴虚火旺夹湿", new Date("2026-07-14T02:00:00Z")).advice, /辛辣|酒类/);
assert.match(buildSeasonalCare("阴虚火旺夹湿", new Date("2026-07-14T02:00:00Z")).advice, /纳食|腹胀/);
assert.doesNotMatch(buildSeasonalCare("心脾两虚", new Date("2026-07-14T02:00:00Z")).advice, /药|方|剂量/);

const previousResultFixture = {
  ...createInitialCaseState(),
  patient: { name: "张三" },
  previousResult: {
    diagnosis: "张三上一版辨证为心脾两虚",
    prescription: "张三上一版候选方药",
    capturedAt: new Date(0).toISOString(),
  },
};
const persistedPreviousResult = sanitizeCaseStateForBrowserPersistence(previousResultFixture);
assert.doesNotMatch(persistedPreviousResult.previousResult?.diagnosis || "", /张三/);
assert.equal(sanitizeCaseStateForModel(previousResultFixture).previousResult, undefined, "stale results must never enter a new model context");
assert.doesNotMatch(
  sanitizeFreeTextForModel("患者阿卜杜热依木·买买提，男，42岁，近3日失眠。"),
  /阿卜杜热依木|买买提/,
  "long names with a middle dot must be removed before model egress",
);
assert.match(clinicalGroundingText({
  ...createInitialCaseState(),
  chiefComplaint: "饭后腹胀伴嗳气三周",
  conversation: [{ role: "user", content: "无黑便，体重稳定" }],
}), /饭后腹胀伴嗳气三周/, "follow-up conversation must not evict the clinician-entered chief complaint from M03 grounding");
const multimodalGrounding = clinicalGroundingText({
  ...createInitialCaseState(),
  chiefComplaint: "入睡困难2周",
  tongue: "舌红少苔",
  tongueImageDesc: "舌质红，少苔",
  pulse: "脉细数",
  faceNote: "面色少华",
  vitals: { temperature: "39.2℃", pulse: "120次/分" },
  pastHistory: "既往高血压",
  medicationHistory: "现服氨氯地平",
  allergyHistory: "青霉素过敏",
  conversation: [{ role: "user", content: "无胸痛" }],
});
for (const fact of ["舌红少苔", "舌质红，少苔", "脉细数", "面色少华", "39.2", "120", "既往高血压", "氨氯地平", "青霉素过敏", "无胸痛"]) {
  assert.match(multimodalGrounding, new RegExp(fact), `follow-up conversation must retain recorded fact: ${fact}`);
}
const egressWhitelistProbe = sanitizeCaseStateForModel({
  ...createInitialCaseState(),
  id: "MRN-SECRET-001",
  patient: { name: "赵小明", sex: "男", age: 42 },
  chiefComplaint: "赵小明近3日失眠",
  reasoningDiagnose: { pathogenesis: { chain: [{ patientFact: "患者赵小明近3日失眠" }] } },
  prescriptionRevision: { source: "herb_workbench", candidateIndex: 0, herbHash: "patient-hash", auditedAt: "2026-07-15T00:00:00Z", auditResult: "PASS", highestRiskLevel: "INFO" },
  internalUiDraft: "赵小明仅供界面显示",
});
assert.equal(egressWhitelistProbe.id, "deidentified-case");
assert.equal("prescriptionRevision" in egressWhitelistProbe, false, "audit/workbench state must not be forwarded to the model");
assert.equal("internalUiDraft" in egressWhitelistProbe, false, "unknown future UI state must be excluded by the model egress allowlist");
assert.doesNotMatch(JSON.stringify(egressWhitelistProbe), /赵小明|MRN-SECRET|patient-hash/);
assert.equal(
  sanitizeCaseStateForModel({ ...createInitialCaseState(), patient: { occupation: "某国家重点实验室唯一首席研究员" } }).patient.occupation,
  "[职业已泛化]",
  "rare occupation titles must be generalized before external model egress",
);

const timestampPersistenceProbe = sanitizeCaseStateForBrowserPersistence({
  ...createInitialCaseState(),
  patient: { occupation: "大学教授" },
  previousResult: { capturedAt: "2026-07-19T14:23:51+08:00", diagnosis: "失眠" },
  faceCapture: {
    schemaVersion: "face-capture-v1",
    quality: { score: 0.8, issues: [], needRetake: false },
    complexion: [], spirit: [], shape: [], notes: "",
    clinicalEvidenceLevel: "reference-only",
    updatedAt: "2026-07-19T14:23:51+08:00",
  },
});
assert.equal(timestampPersistenceProbe.patient.occupation, "教育工作");
assert.equal(timestampPersistenceProbe.previousResult?.capturedAt, "2026-07-19");
assert.equal(timestampPersistenceProbe.faceCapture?.updatedAt, "2026-07-19");

for (const herb of ["桂圆肉", "炒白术", "麸炒白术", "炒酸枣仁", "制远志", "蜜炙黄芪", "炙黄芪", "蜜炙甘草", "茯神", "煅牡蛎"]) {
  assert.equal(isKnownTcmHerbName(herb), true, herb);
}
for (const herb of ["归脾安神草", "未知测试药", "炒未知草"]) {
  assert.equal(isKnownTcmHerbName(herb), false, herb);
}

function stateFromRecord(rawText, fields = {}) {
  return {
    ...createInitialCaseState(),
    phase: "question",
    chiefComplaint: fields.zhushu || rawText,
    hisRecord: {
      source: "manual",
      encounterId: "test",
      rawText,
      fields: { zhushu: fields.zhushu || rawText, ...fields },
      collectedAt: new Date(0).toISOString(),
      tongueImageUploaded: false,
    },
    conversation: [{ role: "user", content: rawText }],
  };
}

for (const input of ["家属张三反映患者夜间失眠。", "联系人李四称症状加重。", "陪同者王五表示已服药。", "医生赵六记录舌淡。"] ) {
  assert.doesNotMatch(scrubPersistentPhiText(input), /张三|李四|王五|赵六/);
  assert.doesNotMatch(sanitizeFreeTextForModel(input), /张三|李四|王五|赵六/);
}

const negatedChest = stateFromRecord(
  "否认胸痛、胸闷，但今日突发晕厥并短暂意识丧失约1分钟，后自行清醒。",
  { zhushu: "否认胸痛、胸闷，但突发晕厥并短暂意识丧失" },
);
negatedChest.symptoms = { chestPain: "突发胸痛", syncope: "突发晕厥" };
const negatedFlags = detectProgrammaticRedFlags(negatedChest);
assert.equal(negatedFlags.length, 0);
const negatedAdvisories = evaluateSafetyGate(negatedChest).advisories || [];
assert.match(negatedAdvisories.join("\n"), /晕厥|意识丧失/);
assert.doesNotMatch(negatedAdvisories.join("\n"), /胸痛|胸闷/);

const laterPositive = stateFromRecord("起初否认胸痛，随后新发压榨性胸痛并大汗。", { zhushu: "新发胸痛" });
assert.match(detectProgrammaticRedFlags(laterPositive).join("\n"), /胸痛/);

for (const text of [
  "胸口突然像石头压着，出一身冷汗，一个小时前开始，歇着也不缓。",
  "刚才心口像有重物压住，喘不过气。",
  "胸前突然发紧，冷汗直冒，持续二十分钟没有缓解。",
]) {
  assert.match(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: text })).join("\n"), /心血管|胸痛|胸闷/, text);
}
for (const text of [
  "否认胸口像石头压着、胸痛、胸闷或冷汗。",
  "不是胸痛，也没有胸闷或冷汗。",
  "并非胸痛，不曾出现冷汗。",
  "以前紧张时偶尔胸口发紧，已由心内科评估为非急症，目前无不适。",
]) {
  assert.doesNotMatch(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).join("\n"), /心血管|胸痛|胸闷/, text);
}
for (const text of [
  "不是黑便，也没有吐血。",
  "并非便血，不曾呕血。",
  "不是咯血，也没有阴道流血或外伤出血。",
  "不是突发腹痛，也没有反跳痛。",
  "腹痛不是很重，仍持续存在。",
]) {
  assert.equal(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).length, 0, text);
}
for (const text of [
  "突发胸痛不是很重，但伴冷汗。",
  "不是胸痛，后来突发压榨性胸痛伴冷汗。",
  "突发腹痛不是很重，但按压后松手更痛。",
  "突然腹痛，伴反跳痛。",
]) {
  assert.notEqual(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: text })).length, 0, text);
}
const currentMelenaAfterNegation = stateFromRecord("不是黑便，今晨却排出柏油样便。", { zhushu: "不是黑便，今晨却排出柏油样便。" });
assert.equal(
  detectProgrammaticRedFlags(currentMelenaAfterNegation).length,
  0,
  "single current melena without volume, recurrence, or perfusion evidence stays below the deterministic emergency floor",
);
assert.match(
  evaluateSafetyGate(currentMelenaAfterNegation).advisories.join("\n"),
  /消化道出血|黑便|柏油样便/,
  "the current clause must still survive the earlier negation and remain visible for priority assessment",
);

const duplicatedNarrative = {
  ...createInitialCaseState(),
  chiefComplaint: "头晕半年",
  symptoms: { presentHistory: "头晕半年" },
  tongue: "舌淡苔薄白",
  pulse: "脉细",
};
const duplicatedCompleteness = deriveOperationalCompleteness(duplicatedNarrative);
assert.ok(duplicatedCompleteness.infoGain < 0.7 && duplicatedCompleteness.answerability < 0.7, "copying the chief complaint into present history must not suppress the one-round follow-up");
const distinctNarrative = {
  ...duplicatedNarrative,
  symptoms: { presentHistory: "头晕半年，翻身时天旋地转，每次约半分钟，无肢体无力和言语不清" },
};
assert.ok(deriveOperationalCompleteness(distinctNarrative).infoGain >= 0.7, "branch-changing history must increase operational information gain");

for (const text of [
  "反复想到自杀并已有具体计划。",
  "觉得活着没意思，准备跳楼。",
  "近期轻生念头加重。",
  "昨夜割腕自伤。",
  "有伤害他人的明确计划。",
]) {
  assert.match(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "情绪问题" })).join("\n"), /自杀|自伤|伤害他人/, text);
}
for (const text of [
  "否认自杀、自伤或他伤意念。",
  "既往有自杀未遂，目前否认自杀意念、计划及自伤行为。",
  "建议进一步评估自杀风险。",
]) {
  assert.doesNotMatch(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).join("\n"), /自杀|自伤|伤害他人/, text);
}
const depressionWithoutSafetyScreen = stateFromRecord("近两月情绪低落、兴趣丧失。", {
  zhushu: "情绪低落", sex: "男", tcmTongue: "舌淡红苔薄白", tcmPulse: "脉弦细",
  guomin: "否认药物过敏", yongyaoshi: "否认当前用药",
});
assert.match(evaluateSafetyGate(depressionWithoutSafetyScreen).missingItems.join("、"), /自杀\/自伤\/他伤安全筛查/);
assert.equal(canForceProceedPastSafetyGate(evaluateSafetyGate(depressionWithoutSafetyScreen)), true, "an unanswered screening question stays visible but can be skipped; an explicit crisis remains a red flag");
const depressionScreened = stateFromRecord("近两月情绪低落，但否认自杀、自伤或他伤意念。", {
  zhushu: "情绪低落", sex: "男", tcmTongue: "舌淡红苔薄白", tcmPulse: "脉弦细",
  guomin: "否认药物过敏", yongyaoshi: "否认当前用药",
});
assert.doesNotMatch(evaluateSafetyGate(depressionScreened).missingItems.join("、"), /自杀\/自伤\/他伤安全筛查/);

const insomniaWithoutOsaScreen = stateFromRecord("失眠半年，入睡困难。", {
  zhushu: "失眠半年", sex: "男", tcmTongue: "舌淡红苔薄白", tcmPulse: "脉弦细",
  guomin: "否认药物过敏", yongyaoshi: "否认当前用药",
});
assert.match(evaluateSafetyGate(insomniaWithoutOsaScreen).missingItems.join("、"), /OSA风险筛查/);
assert.equal(canForceProceedPastSafetyGate(evaluateSafetyGate(insomniaWithoutOsaScreen)), true, "non-critical screening gaps may continue as a visibly limited candidate");
const insomniaWithOsaScreen = stateFromRecord("失眠半年；否认明显打鼾、目击呼吸暂停及日间嗜睡，无高血压病史。", {
  zhushu: "失眠半年", sex: "男", tcmTongue: "舌淡红苔薄白", tcmPulse: "脉弦细",
  guomin: "否认药物过敏", yongyaoshi: "否认当前用药",
});
assert.doesNotMatch(evaluateSafetyGate(insomniaWithOsaScreen).missingItems.join("、"), /OSA风险筛查/);
const thyroidClues = stateFromRecord("心悸伴消瘦、多汗手抖。", {
  zhushu: "心悸", sex: "男", tcmTongue: "舌红苔薄", tcmPulse: "脉数",
  guomin: "否认药物过敏", yongyaoshi: "否认当前用药",
});
assert.match(evaluateSafetyGate(thyroidClues).missingItems.join("、"), /甲状腺功能/);
const thyroidAssessed = stateFromRecord("心悸伴消瘦、多汗手抖；近期甲状腺功能检查异常，待专科复核。", {
  zhushu: "心悸", sex: "男", tcmTongue: "舌红苔薄", tcmPulse: "脉数",
  guomin: "否认药物过敏", yongyaoshi: "否认当前用药",
});
assert.doesNotMatch(evaluateSafetyGate(thyroidAssessed).missingItems.join("、"), /甲状腺功能/);
const thyroidNegated = stateFromRecord("否认心悸、消瘦、多汗手抖，偶有入睡困难；否认打鼾、呼吸暂停及日间嗜睡，无高血压。", {
  zhushu: "入睡困难", sex: "男", tcmTongue: "舌淡红苔薄白", tcmPulse: "脉弦细",
  guomin: "否认药物过敏", yongyaoshi: "否认当前用药",
});
assert.doesNotMatch(evaluateSafetyGate(thyroidNegated).missingItems.join("、"), /甲状腺功能/);

const noTrigger = stateFromRecord("无明显诱因突发压榨性胸痛，持续30分钟。", { zhushu: "突发胸痛" });
assert.match(detectProgrammaticRedFlags(noTrigger).join("\n"), /胸痛/);
assert.match(detectProgrammaticRedFlags(stateFromRecord("本次血压130/220mmHg。", { zhushu: "复诊", vitalsBP: "130/220" })).join("\n"), /倒置|危急值/);
assert.doesNotMatch(detectProgrammaticRedFlags(stateFromRecord("本次血压90/120mmHg。", { zhushu: "复诊", vitalsBP: "90/120" })).join("\n"), /倒置且包含危急值/);
const severeHypertensionWithoutTargetOrganSymptoms = stateFromRecord("当前收缩压190mmHg，舒张压122mmHg，否认胸痛、气促、视物异常、肢体无力或言语不清。", {
  zhushu: "复诊",
  vitalsDetail: "当前收缩压190mmHg，舒张压122mmHg",
});
assert.doesNotMatch(detectProgrammaticRedFlags(severeHypertensionWithoutTargetOrganSymptoms).join("\n"), /血压|危急值/);
assert.match(measuredVitalAdvisories(severeHypertensionWithoutTargetOrganSymptoms).join("\n"), /血压 190\/122mmHg|立即规范复测/);
assert.match(detectProgrammaticRedFlags(stateFromRecord("指脉氧89%。", {
  zhushu: "复诊",
  vitalsDetail: "指脉氧89%",
})).join("\n"), /血氧|低氧/);
for (const invalidOxygen of ["SpO2 999%", "指脉氧999%", "氧饱和度101%"] ) {
  const invalidOxygenState = stateFromRecord(`复诊，${invalidOxygen}。`, {
    zhushu: "复诊",
    sex: "男",
    guomin: "否认药物过敏",
    yongyaoshi: "目前未用药",
    tcmTongue: "舌淡，苔薄白",
    tcmPulse: "脉细",
    vitalsDetail: invalidOxygen,
  });
  const invalidOxygenGate = evaluateSafetyGate(invalidOxygenState);
  assert.notEqual(invalidOxygenGate.status, "ready", invalidOxygen);
  assert.equal(invalidOxygenGate.allowDosePrescription, false, invalidOxygen);
  assert.match(invalidOxygenGate.missingItems.join("、"), /生命体征数值需复核.*血氧/, invalidOxygen);
  assert.equal(canForceProceedPastSafetyGate(invalidOxygenGate), true, invalidOxygen);
  assert.equal(hardDoseSafetyBoundaryReasons(invalidOxygenState).length, 0, invalidOxygen);
  assert.doesNotMatch(detectProgrammaticRedFlags(invalidOxygenState).join("\n"), /低氧|血氧饱和度低/, invalidOxygen);
}

for (const text of [
  "健康宣教：若出现胸痛、呼吸困难应立即急诊；患者目前无上述不适。",
  "其父亲曾有晕厥史，患者本人从未发生晕厥。",
]) {
  assert.equal(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).length, 0, text);
}
const conditionalSemanticFact = stateFromRecord(
  "健康宣教：若出现胸痛、呼吸困难应立即急诊；患者目前无上述不适。",
  { zhushu: "复诊" },
);
conditionalSemanticFact.clinicalFacts = { redFlags: [{ category: "cardiac", status: "positive", quote: "若出现胸痛" }] };
assert.equal(detectProgrammaticRedFlags(conditionalSemanticFact).length, 0, "conditional semantic facts must remain outside the patient-positive span");
const familySemanticFact = stateFromRecord("其父亲曾有晕厥史，患者本人从未发生晕厥。", { zhushu: "复诊" });
familySemanticFact.clinicalFacts = { redFlags: [{ category: "syncope", status: "positive", quote: "其父亲曾有晕厥史" }] };
assert.equal(detectProgrammaticRedFlags(familySemanticFact).length, 0, "non-patient semantic facts must not bypass subject scoping");

const staleClearance = stateFromRecord("2小时前突发压榨性胸痛伴大汗；一周前心电图正常，肌钙蛋白阴性。", { zhushu: "突发胸痛" });
assert.match(detectProgrammaticRedFlags(staleClearance).join("\n"), /胸痛/);
const staleClearanceAfter = stateFromRecord("2小时前突发压榨性胸痛伴大汗；心电图一周前正常，肌钙蛋白一周前阴性。", { zhushu: "突发胸痛" });
assert.match(detectProgrammaticRedFlags(staleClearanceAfter).join("\n"), /胸痛/);
const staleClearanceParenthetical = stateFromRecord("2小时前突发压榨性胸痛伴大汗；心电图正常（一周前报告），肌钙蛋白阴性（一周前报告）。", { zhushu: "突发胸痛" });
assert.match(detectProgrammaticRedFlags(staleClearanceParenthetical).join("\n"), /胸痛/);
const staleClearanceAbsolute = stateFromRecord("2小时前突发胸痛；2026年6月1日心电图正常，2026年6月1日肌钙蛋白阴性。", { zhushu: "复诊" });
assert.match(detectProgrammaticRedFlags(staleClearanceAbsolute).join("\n"), /胸痛/);
const staleClearanceMonthDay = stateFromRecord("2小时前突发胸痛；6月1日心电图正常，6月1日肌钙蛋白阴性。", { zhushu: "复诊" });
assert.match(detectProgrammaticRedFlags(staleClearanceMonthDay).join("\n"), /胸痛/);
const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
const tomorrowText = `${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日`;
const futureDatedClearance = stateFromRecord(`2小时前突发胸痛；${tomorrowText}心电图正常，${tomorrowText}肌钙蛋白阴性。`, { zhushu: "复诊" });
assert.match(detectProgrammaticRedFlags(futureDatedClearance).join("\n"), /胸痛/);
const tomorrowIso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
assert.match(detectProgrammaticRedFlags(stateFromRecord(`2小时前突发胸痛；${tomorrowIso}心电图正常，${tomorrowIso}肌钙蛋白阴性。`, { zhushu: "复诊" })).join("\n"), /胸痛/);
assert.match(detectProgrammaticRedFlags(stateFromRecord("2小时前突发胸痛；2月30日心电图正常，2月30日肌钙蛋白阴性。", { zhushu: "复诊" })).join("\n"), /胸痛/);
const todayParts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
const todayPart = (type) => Number(todayParts.find((part) => part.type === type)?.value);
const todayText = `${todayPart("year")}年${todayPart("month")}月${todayPart("day")}日`;
assert.equal(detectProgrammaticRedFlags(stateFromRecord(`2小时前突发胸痛；${todayText}已由急诊评估排除急性冠脉事件，目前无胸痛胸闷气促。`, { zhushu: "复诊" })).length, 0);
const currentClearanceWithVitals = stateFromRecord("胸痛已由心内科评估为肋软骨炎/非急症，当前无胸痛胸闷气促，T36.6 P76 R18 BP122/76。", { zhushu: "复诊" });
assert.equal(detectProgrammaticRedFlags(currentClearanceWithVitals).length, 0);
for (const text of ["否认胸痛、头痛，昨日起气促。", "否认胸痛、头痛，昨夜开始呼吸困难。", "否认胸痛、头痛，活动后气促。", "否认胸痛、头痛，近两日气促。", "否认胸痛、头痛，今晨气促。", "否认胸痛、头痛，气促持续2小时。"] ) {
  const state = stateFromRecord(text, { zhushu: "呼吸不适" });
  assert.equal(detectProgrammaticRedFlags(state).length, 0, text);
  assert.match(evaluateSafetyGate(state).advisories.join("\n"), /呼吸困难|气促/, text);
}
for (const text of ["气促半天。", "气促1天。", "气促一天。", "气促2日。", "近期气促。", "近来气促。", "最近气促。"] ) {
  const state = stateFromRecord(text, { zhushu: "呼吸不适" });
  assert.equal(detectProgrammaticRedFlags(state).length, 0, text);
  assert.match(evaluateSafetyGate(state).advisories.join("\n"), /呼吸困难|气促/, text);
}
for (const text of ["否认气促，已持续2小时无气促。", "否认胸痛、气促，持续2小时无不适。"] ) {
  assert.doesNotMatch(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).join("\n"), /呼吸困难|气促/, text);
}
for (const text of ["否认胸痛、头痛，近两日气促未再发。", "否认胸痛、头痛，近两日呼吸困难未出现。", "否认胸痛、头痛，今晨气促已缓解。"] ) {
  assert.doesNotMatch(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).join("\n"), /呼吸困难|气促/, text);
}
for (const text of ["数年前气促持续2小时，当前无不适。", "既往曾有急性气促，现无再发。"] ) {
  assert.doesNotMatch(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).join("\n"), /呼吸困难|气促/, text);
}
for (const text of ["既往曾有气促，本次再发并加重。", "数年前气促已缓解，今晨再次气促。"] ) {
  const state = stateFromRecord(text, { zhushu: "呼吸不适" });
  assert.equal(detectProgrammaticRedFlags(state).length, 0, text);
  assert.match(evaluateSafetyGate(state).advisories.join("\n"), /呼吸困难|气促/, text);
}
for (const text of ["既往气促已缓解，当前再发。", "既往气促已缓解，现在又气促。", "既往气促已缓解，目前复发。", "既往气促已缓解，当前再发气促。"] ) {
  const state = stateFromRecord(text, { zhushu: "呼吸不适" });
  assert.equal(detectProgrammaticRedFlags(state).length, 0, text);
  assert.match(evaluateSafetyGate(state).advisories.join("\n"), /呼吸困难|气促/, text);
}
for (const text of ["气促一天，现已缓解。", "气促半天，目前无气促。", "气促2日，现未再发。"] ) {
  assert.doesNotMatch(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).join("\n"), /呼吸困难|气促/, text);
}
for (const text of [
  "突发胸痛30分钟，经急诊评估尚未排除ACS。",
  "突发胸痛30分钟，经急诊评估不能排除ACS。",
  "突发胸痛30分钟，已经建议急诊评估排除ACS。",
  "突发胸痛30分钟，心电图正常，肌钙蛋白阴性。",
]) {
  assert.match(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).join("\n"), /胸痛/, text);
}
for (const text of [
  "2小时前突发胸痛伴大汗，一周前，经心内科评估排除ACS，目前无胸痛。",
  "2小时前突发胸痛伴大汗,两周前,经心内科评估排除ACS,目前无胸痛。",
  "2小时前突发胸痛伴大汗；上周，患者曾在外院就诊，已由心内科评估排除ACS。",
  "2小时前突发胸痛伴大汗；去年，经急诊评估排除ACS。",
]) {
  assert.match(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).join("\n"), /胸痛/, text);
}
for (const text of ["突发胸痛30分钟，今日急诊已明确排除ACS，目前无胸痛。", "突发胸痛30分钟，急诊评估后明确排除ACS，目前无胸痛。"] ) {
  assert.equal(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).length, 0, text);
}
for (const text of ["突发胸痛30分钟，今日已明确由急诊排除ACS，目前无胸痛。", "突发胸痛30分钟，今日明确经急诊排除ACS，目前无胸痛。", "突发胸痛30分钟，今日明确排除ACS，经急诊确认，目前无胸痛。"] ) {
  assert.equal(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).length, 0, text);
}
for (const text of [
  "2小时前突发胸痛伴大汗；2026年6月1日，已由心内科评估排除急性冠脉事件。",
  "2小时前突发胸痛伴大汗；2026年6月1日患者曾在外院就诊，已由心内科评估排除急性冠脉事件。",
  "2小时前突发胸痛伴大汗；2026年8月1日，已由急诊评估排除急性冠脉事件。",
]) {
  assert.match(detectProgrammaticRedFlags(stateFromRecord(text, { zhushu: "复诊" })).join("\n"), /胸痛/, text);
}

const noHisLatestMessage = createInitialCaseState();
noHisLatestMessage.conversation = [
  { role: "user", content: "本次只是睡眠差，否认胸痛胸闷" },
];
noHisLatestMessage.symptoms = { chestPain: "突发压榨性胸痛" };
assert.equal(detectProgrammaticRedFlags(noHisLatestMessage).length, 0);

const laterUnrelatedSupplementMustNotEraseRisk = stateFromRecord("2小时前突发压榨性胸痛伴大汗。", { zhushu: "突发胸痛" });
laterUnrelatedSupplementMustNotEraseRisk.conversation.push(
  { role: "assistant", content: "请补充舌脉。" },
  { role: "user", content: "舌淡，脉细。" },
);
assert.match(
  detectProgrammaticRedFlags(laterUnrelatedSupplementMustNotEraseRisk).join("\n"),
  /胸痛/,
  "a later benign supplement must not erase an earlier current red flag",
);

const hisPlusConversationRisk = stateFromRecord("失眠3个月。", { zhushu: "失眠3个月" });
hisPlusConversationRisk.conversation.push(
  { role: "assistant", content: "还有其他不适吗？" },
  { role: "user", content: "刚才突发胸闷并大汗。" },
);
assert.match(
  detectProgrammaticRedFlags(hisPlusConversationRisk).join("\n"),
  /胸痛|胸闷/,
  "new clinician/patient facts after the HIS snapshot must participate in safety evaluation",
);

for (const value of ["舌象待核实（图片模糊）", "脉象尚未核实，患者说不清", "舌象无法判断，光线不足", "当前用药不详，家属未带药盒"]) {
  assert.equal(isUnknownClinicalText(value), true, value);
}
assert.equal(isUnknownClinicalText("舌象待核实，但本次可见舌淡苔薄白"), false);
assert.equal(isUnknownClinicalText("当前用药不详，现服阿司匹林100mg每日一次"), false);
for (const value of [
  "外伤后出血不止30分钟，暂未测生命体征",
  "排黑色便3天，血红蛋白未测",
  "晕厥一次，目前诱因待确认",
  "胸闷持续加重，血氧尚未测",
]) {
  assert.equal(isUnknownClinicalText(value), false, `a documented current presentation must survive an unrelated unknown field: ${value}`);
}
for (const value of [
  "疑似胸痛待确认",
  "是否晕厥尚未核实",
  "生命体征暂未测",
]) {
  assert.equal(isUnknownClinicalText(value), true, `an event that is itself unconfirmed must remain unknown: ${value}`);
}
assert.equal(isUnknownClinicalFieldText("舌象待核实，现服阿司匹林100mg每日一次", "tongue"), true);
assert.equal(isUnknownClinicalFieldText("舌象待核实，但本次可见舌淡苔薄白", "tongue"), false);
const crossFieldUnknownTongue = stateFromRecord("舌象待核实，现服阿司匹林100mg每日一次。", {
  zhushu: "睡眠差", tcmTongue: "舌象待核实，现服阿司匹林100mg每日一次", tcmPulse: "脉弦细",
  sex: "男", guomin: "否认药物过敏", yongyaoshi: "现服阿司匹林100mg每日一次",
});
assert.match(evaluateSafetyGate(crossFieldUnknownTongue).missingItems.join("、"), /舌象/);

const oldModelSelfLock = stateFromRecord("否认胸痛胸闷，无其他急性不适。", { zhushu: "睡眠不佳" });
oldModelSelfLock.diagnosis = "## 红旗排查\n高风险：胸痛已出现，建议急诊";
assert.equal(evaluateSafetyGate(oldModelSelfLock).redFlags.length, 0);
oldModelSelfLock.vitals = { BP: "220/130mmHg", T: "41℃", P: "140次/分", R: "35次/分" };
assert.match(
  detectProgrammaticRedFlags(oldModelSelfLock).join("；"),
  /血压|体温|心率|呼吸/,
  "structured current vital measurements remain safety-significant even when an HIS snapshot exists",
);

const unknownTonguePulse = stateFromRecord("最近睡眠不佳。舌象和脉象尚未核实，待核实。", {
  zhushu: "最近睡眠不佳",
  tcmTongue: "舌象待核实",
  tcmPulse: "脉象待核实",
  sex: "男",
  guomin: "否认药物及食物过敏",
  yongyaoshi: "目前无正在使用的中西药或保健品",
});
unknownTonguePulse.tongue = "舌象待核实";
unknownTonguePulse.pulse = "脉象待核实";
unknownTonguePulse.completeness = { level: "C", redFlag: 1, infoGain: 1, managementImpact: 1, answerability: 1 };
const recomputed = withSafetyGate(unknownTonguePulse);
assert.notEqual(recomputed.completeness.level, "C");
assert.deepEqual(recomputed.safetyGate?.missingItems.filter((item) => /舌象|脉象/.test(item)), ["舌象", "脉象"]);
unknownTonguePulse.tongue = "舌淡苔薄白";
unknownTonguePulse.pulse = "脉弦细";
assert.deepEqual(withSafetyGate(unknownTonguePulse).safetyGate?.missingItems.filter((item) => /舌象|脉象/.test(item)), ["舌象", "脉象"]);

const hallucinated = [
  "## 红旗排查",
  "患者无头痛、视物模糊。",
  "现有信息支持肾功能正常。",
  "舌淡苔薄白，脉弦细。",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ stage: "diagnose", note: "无头痛，肾功能正常，脉弦细" }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");
const grounded = sanitizeUngroundedRedFlagNegations(hallucinated, unknownTonguePulse);
assert.doesNotMatch(grounded, /无头痛|肾功能正常|脉弦细|舌淡|苔薄白/);
assert.match(grounded, /待核实/);
const groundedJson = JSON.parse(grounded.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim());
assert.doesNotMatch(JSON.stringify(groundedJson), /无头痛|肾功能正常|脉弦细/);
const preservedDiagnosisIdentity = sanitizeUngroundedRedFlagNegations([
  "西医诊断倾向：偏头痛。",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ stage: "diagnose", westernDiagnosis: { primary: { name: "偏头痛", supportingFacts: ["患者无胸痛"] } } }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), unknownTonguePulse);
const preservedDiagnosisIdentityJson = JSON.parse(preservedDiagnosisIdentity.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim());
assert.equal(preservedDiagnosisIdentityJson.westernDiagnosis.primary.name, "偏头痛");
assert.doesNotMatch(preservedDiagnosisIdentityJson.westernDiagnosis.primary.supportingFacts.join("；"), /患者无胸痛/);
const partialGrounded = sanitizeUngroundedRedFlagNegations("患者无胸痛、头痛。", stateFromRecord("患者否认胸痛。", { zhushu: "睡眠差" }));
assert.match(partialGrounded, /否认胸痛/);
assert.doesNotMatch(partialGrounded, /头痛.*待核实|阴性史待核实/);
assert.match(partialGrounded, /本次主诉及伴随症状变化/);
const contradictedAcutePositive = sanitizeUngroundedRedFlagNegations(
  "未记录气促、大汗。",
  stateFromRecord("突发胸痛，伴气促、大汗。", { zhushu: "突发胸痛，伴气促、大汗" }),
);
assert.match(contradictedAcutePositive, /病历已记录气促、大汗阳性/);
assert.doesNotMatch(contradictedAcutePositive, /气促、大汗阴性史待核实|未记录气促/);
const differentialNegations = sanitizeUngroundedRedFlagNegations(
  "患者无怕冷、怕热、消瘦、突眼。无打鼾、呼吸暂停主诉；无面色苍白、头晕；无胸胁满、善太息。",
  stateFromRecord("患者入睡困难，多梦易醒。", { zhushu: "入睡困难" }),
);
assert.doesNotMatch(differentialNegations, /患者无怕冷|无打鼾|无面色苍白|无胸胁满/);
for (const term of ["怕冷", "怕热", "消瘦", "突眼", "打鼾", "呼吸暂停", "面色苍白", "头晕", "胸胁满", "善太息"]) {
  assert.doesNotMatch(differentialNegations, new RegExp(term), term);
}
assert.doesNotMatch(differentialNegations, /阴性史待核实|未记录|待核实/);
assert.match(differentialNegations, /本次主诉及伴随症状变化/);

const documentedNormal = stateFromRecord("本次肌酐与eGFR检查后，肾功能正常。", { zhushu: "复查" });
const insomniaSynonyms = stateFromRecord("入睡困难，多梦易醒，醒后再睡困难。", { zhushu: "入睡困难、多梦易醒3个月" });
const preservedInsomniaSynonyms = sanitizeUngroundedRedFlagNegations("患者失眠、早醒，病程3个月。", insomniaSynonyms);
assert.match(preservedInsomniaSynonyms, /患者失眠、早醒/);
assert.doesNotMatch(preservedInsomniaSynonyms, /阳性表现未在本次病历中明确记录/);
const colloquialNightSweat = stateFromRecord("夜里总出汗，睡醒后才发现汗湿，睡不好一个月。", { zhushu: "夜里总出汗，睡不好一个月" });
const preservedNightSweatConcept = sanitizeUngroundedRedFlagNegations("患者盗汗，伴睡眠不佳。", colloquialNightSweat);
assert.match(preservedNightSweatConcept, /患者盗汗/);
assert.doesNotMatch(preservedNightSweatConcept, /盗汗阳性表现未在本次病历中明确记录/);
assert.match(sanitizeUngroundedRedFlagNegations("本次肾功能正常。", documentedNormal), /肾功能正常/);
const documentedThyroid = stateFromRecord(`${todayText}甲状腺功能未见明显异常。`, { zhushu: "失眠", age: "48岁" });
assert.match(sanitizeUngroundedRedFlagNegations("具体年龄未提供；甲状腺功能待核实。", documentedThyroid), /年龄已记录为48岁/);
assert.match(sanitizeUngroundedRedFlagNegations("具体年龄未提供；甲状腺功能待核实。", documentedThyroid), /病历已记录本次甲状腺功能未见明显异常/);
assert.match(sanitizeUngroundedRedFlagNegations("肾功能待核实。", stateFromRecord("肾功能异常，甲状腺功能正常。", { zhushu: "复查" })), /肾功能待核实/);
assert.match(sanitizeUngroundedRedFlagNegations("肾功能待核实。", stateFromRecord("2024-05-01肾功能正常。", { zhushu: "复查" })), /肾功能待核实/);

const conversationalMedication = stateFromRecord("睡前偶尔服用褪黑素 3mg 1片，无其他药物。", {
  zhushu: "入睡困难6个月",
  sex: "男",
  age: "48岁",
  tcmTongue: "舌淡红苔薄白",
  tcmPulse: "脉弦细",
  guomin: "否认药物及食物过敏",
  yongyaoshi: "睡前偶尔服用褪黑素 3mg 1片，无其他药物",
});
assert.doesNotMatch(evaluateSafetyGate(conversationalMedication).missingItems.join("、"), /当前用药|药名\/剂量\/频次/);
for (const medication of ["华法林 2.5mg qd", "硝苯地平控释片 30mg qd", "褪黑素 3mg 睡前服用"]) {
  const structuredMedication = stateFromRecord(medication, {
    zhushu: "入睡困难6个月", sex: "男", age: "48岁", tcmTongue: "舌淡红苔薄白", tcmPulse: "脉弦细",
    guomin: "否认药物及食物过敏", yongyaoshi: medication,
  });
  assert.doesNotMatch(evaluateSafetyGate(structuredMedication).missingItems.join("、"), /当前用药|药名\/剂量\/频次/, medication);
}
for (const medication of ["在吃降压药", "每天吃一片降压药", "口服阿司匹林100mg", "现服阿司匹林每日一次"]) {
  const incompleteMedication = stateFromRecord(medication, {
    zhushu: "入睡困难6个月", sex: "男", age: "48岁", tcmTongue: "舌淡红苔薄白", tcmPulse: "脉弦细",
    guomin: "否认药物及食物过敏", yongyaoshi: medication,
  });
  assert.match(evaluateSafetyGate(incompleteMedication).missingItems.join("、"), /药名\/剂量\/频次/, medication);
}
const ageConflict = stateFromRecord("男性，年龄记录待核。", {
  zhushu: "入睡困难", sex: "男", age: "58岁", tcmTongue: "舌淡红苔薄白", tcmPulse: "脉弦细",
  guomin: "否认药物过敏", yongyaoshi: "否认当前用药",
});
ageConflict.patient.age = 48;
assert.match(evaluateSafetyGate(ageConflict).missingItems.join("、"), /年龄记录冲突/);
const ageConflictOutput = sanitizeUngroundedRedFlagNegations([
  "具体年龄未提供。",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ stage: "diagnose", note: "具体年龄未提供" }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), ageConflict);
assert.equal((ageConflictOutput.match(/年龄记录存在冲突/g) || []).length, 2);

const maleApplicabilityState = stateFromRecord("35岁男性，入睡困难。", { zhushu: "入睡困难", sex: "男", age: "35岁" });
const maleApplicableOutput = sanitizeUngroundedRedFlagNegations([
  "川芎需注意经期出血；孕妇禁用；本例需观察头晕。",
  "| 药名 | 安全提示 |",
  "|---|---|",
  "| 川芎 | 月经量过多者慎用 |",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ stage: "prescribe", riskNote: "哺乳期慎用；注意头晕" }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), maleApplicabilityState);
assert.doesNotMatch(maleApplicableOutput, /月经|经期|妊娠|孕妇|孕期|孕产|哺乳/);
assert.match(maleApplicableOutput, /注意头晕|观察头晕/);

const maleLingxiOutput = buildLingxiRiskSection({
  ok: true,
  source: "lingxi",
  degraded: false,
  auditResult: "BLOCK",
  highestRiskLevel: "CRITICAL",
  needManualReview: true,
  itemCount: 1,
  issues: [{
    issueId: "LX-1001",
    riskLevel: "CRITICAL",
    title: "孕妇禁用",
    description: "孕期禁用，备孕女性停药",
    suggestions: ["哺乳期停药"],
    relatedItemNos: [1],
    evidence: [],
    action: "BLOCK",
  }],
}, "男");
assert.match(maleLingxiOutput, /LX-1001/);
assert.match(maleLingxiOutput, /强提示，需人工复核/);
assert.match(maleLingxiOutput, /孕期禁用/);
assert.doesNotMatch(maleLingxiOutput, /当前资料判定不适用|未见需提示问题/);

assert.deepEqual(normalizeExternalEvidenceResponse("literature", {
  data: [{ title: "伪造文献", url: "http://127.0.0.1/fake", summary: "无可追溯元数据" }],
}), [], "untraceable upstream metadata must not receive a customer-visible evidence ID");
assert.deepEqual(normalizeExternalEvidenceResponse("instruction", "只有一段无来源说明书文本"), [], "unattributed full text is not a traceable instruction source");
assert.deepEqual(normalizeExternalEvidenceResponse("instruction", {
  data: [{ drugName: "某药说明书", approvalNumber: "国药准字Z12345678", manufacturer: "某药企", summary: "适应证文本" }],
}), [{
  sourceKind: "instruction",
  title: "某药说明书",
  publisher: "某药企",
  identifier: "国药准字Z12345678",
  summary: "适应证文本",
}], "an instruction with product identity and approval number remains traceable");

const contradictoryPregnancy = stateFromRecord("已妊娠12周。", {
  zhushu: "入睡困难",
  sex: "男",
  age: "45岁",
  tcmTongue: "舌淡苔薄白",
  tcmPulse: "脉弦细",
  guomin: "否认药物过敏",
  yongyaoshi: "否认当前用药",
});
const pregnancyGate = evaluateSafetyGate(contradictoryPregnancy);
assert.equal(pregnancyGate.allowDiagnosis, true);
assert.equal(pregnancyGate.allowDosePrescription, false);
assert.match(pregnancyGate.missingItems.join("、"), /特殊人群用药复核/);

for (const age of ["11岁", "56岁"]) {
  const femaleUnknownPotential = stateFromRecord("女性，月经及生育状态未记录。", {
    zhushu: "入睡困难", sex: "女", age, tcmTongue: "舌淡苔薄白", tcmPulse: "脉弦细",
    guomin: "否认药物过敏", yongyaoshi: "否认当前用药",
  });
  assert.equal(evaluateSafetyGate(femaleUnknownPotential).allowDosePrescription, false, age);
}

const herb = (name, dose, role, targetPathogenesis, fn, decoctionRequirement) => ({
  name, dose, role, targetPathogenesis, function: fn, prescriptionRole: fn, processing: null,
  targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null,
  decoctionRequirement, evidence: { evidenceLevel: "model_inference", source: "本例病机", confidence: "中" },
});
const originalCandidate = {
  name: "酸枣仁汤加减",
  positioning: "首选",
  formulaSource: { evidenceLevel: "classic", source: "《金匮要略》", confidence: "高" },
  therapyMatch: "酸枣仁养血安神；加夜交藤助君安神",
  applicable: "失眠并适合夜交藤者",
  notApplicable: "对夜交藤过敏者",
  herbs: [
    herb("酸枣仁", "15g", "君", "心血不足", "养血安神", "捣碎后同煎"),
    herb("夜交藤", "15g", "佐", "心神不宁", "养心安神"),
  ],
  formulaAnalysis: "酸枣仁为君，加夜交藤助君安神。",
  decoction: { doseCount: "5剂", method: "每日1剂；冷水浸泡30分钟；煎煮2次；合并约400mL；早晚分服；夜交藤同煎", course: "5日", followUpNode: "5日复诊" },
};
const editedHerbs = [
  originalCandidate.herbs[0],
  herb("合欢皮", "12g", "佐", "肝郁心神不宁", "解郁安神"),
];
const synchronized = synchronizeEditedCandidate(originalCandidate, editedHerbs);
assert.doesNotMatch(JSON.stringify(synchronized), /夜交藤/);
assert.match(synchronized.formulaAnalysis, /合欢皮/);
assert.match(synchronized.formulaAnalysis, /解郁安神/);
assert.equal(synchronized.constructionType, "self_devised");
assert.equal(synchronized.name, "本例辨证组方（医生编辑版）");
assert.match(synchronized.baseFormulas?.[0]?.source || "", /金匮要略/);
assert.equal(synchronized.baseFormulas?.[0]?.matchedIngredientCount, 1);
assert.doesNotMatch(synchronized.herbs[1].evidence.source, /待重新审方|待确认|占位/);
assert.equal(hasIncompleteEditedHerb({ ...editedHerbs[1], targetPathogenesis: "待医生填写对应病机" }), true);
assert.equal(hasIncompleteEditedHerb(editedHerbs[1]), false);
for (const invalidDose of ["10", "3-6g", "0g", "随便", "-1g"]) {
  assert.equal(hasIncompleteEditedHerb({ ...editedHerbs[1], dose: invalidDose }), true, invalidDose);
}
for (const invalidDose of ["999999g", "0.000001mg"]) {
  assert.equal(hasIncompleteEditedHerb({ ...editedHerbs[1], dose: invalidDose }), true, invalidDose);
}
for (const validDose of ["500mg", "501mg", "999mg"]) {
  assert.equal(hasIncompleteEditedHerb({ ...editedHerbs[1], dose: validDose }), false, validDose);
}
const doseEditedHerbs = originalCandidate.herbs.map((item) => item.name === "酸枣仁" ? { ...item, dose: "30g" } : item);
const doseSynchronized = synchronizeEditedCandidate(originalCandidate, doseEditedHerbs);
assert.match(doseSynchronized.herbs[0].evidence.source, /医生结构化编辑记录/);
const doseMods = filterModificationsForEditedHerbs([
  { trigger: "失眠", targetPathogenesis: "心血不足", action: "加酸枣仁", doseOrHandling: "15g", reason: "养血安神", riskNote: "", evidence: { evidenceLevel: "classic_text", source: "旧依据" } },
], originalCandidate.herbs, doseEditedHerbs);
assert.match(doseMods[0].doseOrHandling || "", /30g/);
assert.doesNotMatch(doseMods[0].doseOrHandling || "", /15g/);
const processedOriginal = {
  ...originalCandidate,
  herbs: [{ ...originalCandidate.herbs[0], processing: "炒", decoctionRequirement: "捣碎后同煎" }, originalCandidate.herbs[1]],
};
const processedEdited = [{ ...processedOriginal.herbs[0], processing: "生", decoctionRequirement: "后下" }, processedOriginal.herbs[1]];
const processedSynchronized = synchronizeEditedCandidate(processedOriginal, processedEdited);
const auditItems = buildAuditItemsFromHerbs({ reasoningV2: {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [processedSynchronized], modifications: [] },
} });
assert.equal(auditItems[0].drug_name, "生酸枣仁");
assert.equal(auditItems[0].decoction_requirement, "炮制：生；后下");
const mgAuditItems = buildAuditItemsFromHerbs({ reasoningV2: {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ ...processedSynchronized, herbs: [{ ...processedSynchronized.herbs[0], dose: "999mg" }] }], modifications: [] },
} });
assert.equal(mgAuditItems[0].single_dose, 999);
assert.equal(mgAuditItems[0].single_dose_unit, "mg");
const secondCandidateAuditItems = buildAuditItemsFromHerbs({ reasoningV2: {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: {
    candidates: [processedOriginal, { ...processedSynchronized, name: "第二候选方", herbs: [{ ...processedSynchronized.herbs[0], name: "茯神", dose: "12g" }] }],
    modifications: [],
  },
} }, 1);
assert.equal(secondCandidateAuditItems[0].drug_name, "生茯神");
assert.equal(secondCandidateAuditItems[0].single_dose, 12);
const regimenAuditData = buildAuditData({ patient: {}, reasoningV2: {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: {
    candidates: [processedSynchronized], modifications: [],
  },
} });
assert.match(String(regimenAuditData?.data?.prescription?.patient?.clinical_summary || ""), /共5剂.*疗程5日.*每日1剂.*复诊节点/);
const phiAuditData = buildAuditData({
  patient: { name: "张三" },
  chiefComplaint: "张三咳嗽3日；Alice Wang 昨夜失眠三周",
  hisRecord: {
    source: "manual",
    encounterId: "phi-audit",
    rawText: "张三咳嗽3日；病历号：ABCD1234；MRN: MRN998877",
    fields: { patientName: "张三", zhushu: "张三咳嗽3日", xianbingshi: "张三近3日咳嗽；病例号 CASE-5678", patientRecordNumber: "PT-20260714" },
    collectedAt: new Date(0).toISOString(),
    tongueImageUploaded: false,
  },
  reasoningV2: {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: { primarySyndrome: "Alice Wang 心脾两虚" }, formula: { candidates: [processedSynchronized], modifications: [] },
  },
});
assert.doesNotMatch(JSON.stringify(phiAuditData?.data || {}), /张三/, "the external audit payload must remove an explicit patient name even when embedded in prose");
assert.doesNotMatch(JSON.stringify(phiAuditData?.data || {}), /ABCD1234|CASE-5678|MRN998877|PT-20260714|Alice Wang/i, "the external audit payload must remove all common medical-record identifiers and English patient names");
assert.equal(prescriptionRegimenFromDecoction(processedSynchronized.decoction)?.dosesPerDay, 1);
assert.equal(prescriptionRegimenFromDecoction({ ...processedSynchronized.decoction, method: "每日2剂，早晚分服" }), null);
assert.equal(prescriptionRegimenFromDecoction({ ...processedSynchronized.decoction, method: "2剂/日，早晚分服" }), null);
assert.equal(prescriptionRegimenFromDecoction({ ...processedSynchronized.decoction, method: "每日1剂，每日2剂，早晚分服" }), null);
assert.equal(prescriptionRegimenFromDecoction({ ...processedSynchronized.decoction, method: "1剂/日，分2次温服" })?.dosesPerDay, 1);
const structuredRegimen = {
  ...processedSynchronized.decoction,
  method: "水煎后早晚分服",
  followUpNode: "疗程结束复诊",
  dailyDoseCount: 1,
  followUpAfterDoses: 5,
  followUpAfterDays: 5,
};
assert.equal(prescriptionRegimenFromDecoction(structuredRegimen)?.dosesPerDay, 1, "structured regimen values are authoritative when display prose omits repeated numbers");
assert.equal(prescriptionRegimenFromDecoction({ ...structuredRegimen, method: "" }), null, "structured dose count must not hide an empty administration method");
assert.equal(prescriptionRegimenFromDecoction({ ...structuredRegimen, followUpNode: "" }), null, "structured follow-up numbers must not hide an empty follow-up instruction");
assert.equal(prescriptionRegimenFromDecoction({ ...structuredRegimen, dailyDoseCount: 2 }), null);
assert.equal(prescriptionRegimenFromDecoction({ ...structuredRegimen, followUpAfterDoses: 4 }), null);
assert.equal(prescriptionRegimenFromDecoction({ ...structuredRegimen, followUpAfterDays: 7 }), null);
assert.equal(prescriptionRegimenFromDecoction({ ...processedSynchronized.decoction, followUpNode: "30日后复诊" }), null);
assert.equal(prescriptionRegimenFromDecoction({ ...processedSynchronized.decoction, followUpNode: "完成4剂后复诊" }), null);
for (const followUpNode of ["0天后复诊", "1天后复诊", "4天后复诊", "6天后复诊", "7天后复诊"]) {
  assert.equal(prescriptionRegimenFromDecoction({ ...processedSynchronized.decoction, followUpNode }), null);
}
const filteredMods = filterModificationsForEditedHerbs([
  { trigger: "多梦", targetPathogenesis: "心神不宁", action: "加夜交藤", doseOrHandling: "15g", reason: "安神", riskNote: "" },
  { trigger: "情志不舒", targetPathogenesis: "肝郁", action: "加合欢皮", doseOrHandling: "12g", reason: "解郁", riskNote: "" },
], originalCandidate.herbs, editedHerbs);
assert.equal(filteredMods.length, 1);
assert.match(filteredMods[0].action, /合欢皮/);
const synthesizedMods = filterModificationsForEditedHerbs([], originalCandidate.herbs, editedHerbs);
assert.equal(synthesizedMods.length, 1);
assert.ok(synthesizedMods.some((item) => item.trigger === "医生结构化编辑" && item.action.includes("合欢皮") && item.doseOrHandling?.includes("12g")));
const versionReasoning = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  formula: { candidates: [synchronized], modifications: synthesizedMods },
};
const versionHash = await computePrescriptionVersionHash(versionReasoning, 0);
assert.match(versionHash, /^sha256-[a-f0-9]{64}$/);
assert.equal(await computePrescriptionVersionHash(versionReasoning, 0), versionHash);
assert.notEqual(await computePrescriptionVersionHash({ ...versionReasoning, formula: { ...versionReasoning.formula, modifications: [{ ...synthesizedMods[0], reason: "变更后的加味原因" }] } }, 0), versionHash);
const auditContextState = stateFromRecord("失眠半年，否认药物过敏。", { zhushu: "失眠半年", guomin: "否认药物过敏", yongyaoshi: "目前未用药" });
const contextHash = await computePrescriptionVersionHash(versionReasoning, 0, auditContextState);
assert.notEqual(await computePrescriptionVersionHash(versionReasoning, 0, { ...auditContextState, allergyHistory: "酸枣仁过敏" }), contextHash);

const staleRestored = reconcileRestoredCaseState({
  ...unknownTonguePulse,
  phase: "done",
  diagnosis: "旧M03",
  prescription: "旧M04剂量处方",
  riskAssessment: "旧M05",
  reasoningPrescribe: { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe" },
  safetyLocked: false,
});
assert.equal(staleRestored.phase, "done");
assert.equal(staleRestored.prescription, "旧M04剂量处方");
assert.equal(staleRestored.riskAssessment, "旧M05");
assert.equal(staleRestored.reasoningPrescribe?.stage, "prescribe");
assert.equal(staleRestored.safetyLocked, true);
const failedRestored = reconcileRestoredCaseState({
  ...unknownTonguePulse,
  phase: "error",
  lastError: "M04失败，请重试当前板块",
  diagnosis: "已完成M03",
});
assert.equal(failedRestored.phase, "error");
assert.match(failedRestored.lastError || "", /M04失败/);
assert.doesNotMatch(buildForcedIncompleteRiskFollowup(unknownTonguePulse), /## 转诊评估|## 红旗预警/, "ordinary missing information must not produce a fixed red-flag template");
const provenanceLockedRestore = reconcileRestoredCaseState({
  ...insomniaWithOsaScreen,
  phase: "done",
  safetyLocked: true,
  prescription: "旧有限候选",
});
assert.equal(provenanceLockedRestore.safetyGate?.status, "ready");
assert.equal(provenanceLockedRestore.safetyLocked, true);
assert.equal(provenanceLockedRestore.prescription, "旧有限候选");

const followUpState = {
  ...unknownTonguePulse,
  reasoningPrescribe: {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    formula: { candidates: [{ decoction: { followUpNode: "5日复诊" } }] },
  },
};
assert.equal(deriveFirstReviewTiming(followUpState, false), "5日复诊");
assert.match(deriveFirstReviewTiming(followUpState, true), /1-3天/);

const partialStream = `${JSON.stringify({ content: "随访".repeat(120) })}\n`;
await assert.rejects(
  consumeMarkdownStream(new Response(partialStream), () => undefined),
  /未完整结束/,
);

const heartbeatFrames = [
  { content: "正在生成本阶段临床推理，请稍候…" },
  { type: "heartbeat", status: "模型正在进行深度推理，服务保持响应并持续校验", processedChars: 320 },
  { content: "<<<CDSS_STREAM_FINAL>>>最终临床内容" },
  { content: "[END]" },
].map((frame) => `${JSON.stringify(frame)}\n`).join("");
const heartbeatPreviews = [];
assert.equal(await consumeMarkdownStream(new Response(heartbeatFrames), (value) => heartbeatPreviews.push(value)), "最终临床内容");
assert.ok(heartbeatPreviews.some((value) => /服务保持响应/.test(value)));

const trailingAfterEnd = [
  { content: "权威正文" },
  { content: "[END]" },
  { content: "尾随污染" },
].map((frame) => `${JSON.stringify(frame)}\n`).join("");
await assert.rejects(
  consumeMarkdownStream(new Response(trailingAfterEnd), () => undefined),
  /模型流格式异常/,
);

let hangingStreamCancelled = false;
const hangingAfterEnd = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ content: "正文" })}\n${JSON.stringify({ content: "[END]" })}\n`));
  },
  cancel() {
    hangingStreamCancelled = true;
  },
});
assert.equal(
  await consumeMarkdownStream(new Response(hangingAfterEnd), () => undefined, { idleTimeoutMs: 500, totalTimeoutMs: 1_000 }),
  "正文",
);
assert.equal(hangingStreamCancelled, true, "END must cancel a provider connection that remains open");

const collectReplacementFrames = [
  { content: "旧问题正文\n<!-- DIAGNOSIS_JSON_START -->\n{}\n<!-- DIAGNOSIS_JSON_END -->" },
  { content: "<<<CDSS_STREAM_" },
  { content: 'FINAL>>>**问题1：** 新问题？\n（追问理由：高信息量。）\n补录字段：现病史\n可选项：\nA. 是\nB. 否\nC. 本次未取得该信息\n\n<!-- DIAGNOSIS_JSON_START -->\n{"completeness":{"level":"B","redFlag":0.6,"infoGain":0.4,"managementImpact":0.4,"answerability":0.4}}\n<!-- DIAGNOSIS_JSON_END -->' },
  { content: "[END]" },
].map((frame) => `${JSON.stringify(frame)}\n`).join("");
const replacedCollect = await consumeCollectStream(new Response(collectReplacementFrames), () => undefined);
assert.match(replacedCollect.displayContent, /新问题/);
assert.doesNotMatch(replacedCollect.displayContent, /旧问题正文|CDSS_STREAM/);
assert.equal(replacedCollect.jsonData?.completeness?.level, "B", "M01/M02 must parse only the authoritative replacement envelope");

const wrongShapeFrames = [
  { content: { bad: true } },
  { content: "[END]" },
].map((frame) => `${JSON.stringify(frame)}\n`).join("");
await assert.rejects(
  consumeMarkdownStream(new Response(wrongShapeFrames), () => undefined),
  /模型流格式异常/,
);

let invalidTimer;
const invalidOnlyStream = new ReadableStream({
  start(controller) {
    invalidTimer = setInterval(() => controller.enqueue(new TextEncoder().encode("not-json\n")), 8);
  },
  cancel() {
    clearInterval(invalidTimer);
  },
});
await assert.rejects(
  consumeMarkdownStream(new Response(invalidOnlyStream), () => undefined, { idleTimeoutMs: 45, totalTimeoutMs: 500 }),
  /长时间无数据/,
);

console.log(JSON.stringify({ cases: 107, failures: 0 }));
