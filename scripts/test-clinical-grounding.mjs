import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  detectProgrammaticRedFlags,
  deriveOperationalCompleteness,
  evaluateSafetyGate,
  canForceProceedPastSafetyGate,
  sanitizeUngroundedRedFlagNegations,
  sanitizeFreeTextForModel,
  deriveFirstReviewTiming,
  hasStrongPrescriptionRisk,
  reconcileRestoredCaseState,
  sanitizeCaseStateForModel,
  sanitizeFreeTextForExternalClinicalService,
  buildForcedIncompleteRiskFollowup,
  clinicalGroundingText,
  hardDoseSafetyBoundaryReasons,
  measuredVitalAdvisories,
  redFlagClearanceFingerprint,
  withSafetyGate,
} = await import("../src/lib/diagnosis-safety.ts");
const { createInitialCaseState } = await import("../src/lib/diagnosis-types.ts");
const { isUnknownClinicalFieldText, isUnknownClinicalText } = await import("../src/lib/clinical-state.ts");
const { consumeCollectStream, consumeMarkdownStream, consumeMarkdownStreamWithMetadata, sanitizeCaseStateForBrowserPersistence, scrubPersistentPhiText } = await import("../src/lib/diagnosis-engine.ts");
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

// ─── PHI quasi-identifier audit probes (2026-07-19) ─────────────────────────
// Gaps (a) unlabeled address tails / compound residences, (b) anchored free-text occupations and
// (c) precise timestamps / bare dates must be scrubbed on BOTH the model egress path and the browser
// snapshot path — the shared scrubber in src/lib/phi-sanitizer.ts backs both.
const phiAuditPaths = [
  ["model", sanitizeFreeTextForModel],
  ["snapshot", scrubPersistentPhiText],
];
for (const [phiPathName, phiScrub] of phiAuditPaths) {
  const phiTag = (probe) => `${phiPathName} path: ${probe}`;
  // (a) 号院 / 号楼 tails and trailing room numbers must not survive.
  const yardAddress = phiScrub("患者住在幸福路12号院3栋502，咳嗽3日");
  assert.doesNotMatch(yardAddress, /幸福路|12号院|3栋|502/, phiTag("号院 address tail must be fully scrubbed"));
  assert.match(yardAddress, /\[地址已脱敏\]/, phiTag("a scrubbed address must leave its marker"));
  assert.match(yardAddress, /咳嗽3日/, phiTag("the clinical duration after an address must survive"));
  const buildingAddress = phiScrub("长期居于建设路7号楼2单元301室，近一周失眠");
  assert.doesNotMatch(buildingAddress, /建设路|7号楼|2单元|301/, phiTag("号楼 address tail must be fully scrubbed"));
  assert.match(buildingAddress, /近一周失眠/, phiTag("clinical text after a 号楼 address must survive"));
  // (a) compound residence: fires only with BOTH a residence anchor and an administrative token.
  const compoundResidence = phiScrub("患者家住朝阳区望京西园四区，近一周失眠");
  assert.doesNotMatch(compoundResidence, /望京西园/, phiTag("an anchored compound residence must be scrubbed"));
  assert.match(compoundResidence, /\[地址已脱敏\]/);
  assert.match(compoundResidence, /近一周失眠/, phiTag("clinical text after a compound residence must survive"));
  assert.equal(phiScrub("查体：腹部四区均可及压痛"), "查体：腹部四区均可及压痛", phiTag("腹部四区 is clinical text, not an address"));
  assert.equal(phiScrub("双方就产业园区合作达成协议"), "双方就产业园区合作达成协议", phiTag("产业园区 without a residence anchor is not an address"));
  // (b) anchored free-text occupation routed through the shared generalizeOccupation.
  const anchoredOccupation = phiScrub("从事航天器研制工作20年，近3日失眠");
  assert.doesNotMatch(anchoredOccupation, /航天器研制/, phiTag("从事… must generalize a rare occupation"));
  assert.match(anchoredOccupation, /20年/, phiTag("the duration after an occupation must survive"));
  assert.match(anchoredOccupation, /近3日失眠/);
  assert.doesNotMatch(phiScrub("工作于市博物馆，近3日失眠"), /市博物馆/, phiTag("工作于… must generalize the employer"));
  assert.doesNotMatch(phiScrub("职业为航天员大队教员，近3日失眠"), /航天员/, phiTag("职业为… must generalize a rare title"));
  assert.match(phiScrub("从事教师工作，近3日失眠"), /从事教育工作/, phiTag("known titles map to their exposure category"));
  // (c) precise timestamps and bare dates.
  const chineseTimestamp = phiScrub("2026年7月18日14:35就诊，主诉失眠");
  assert.doesNotMatch(chineseTimestamp, /2026年7月18日|14:35/, phiTag("a Chinese precise timestamp must be scrubbed"));
  assert.match(chineseTimestamp, /主诉失眠/);
  const spacedIsoTimestamp = phiScrub("2026-07-18 14:35 突发胸痛");
  assert.doesNotMatch(spacedIsoTimestamp, /2026-07-18|14:35/, phiTag("a space-separated ISO datetime must scrub date AND time"));
  assert.match(spacedIsoTimestamp, /突发胸痛/);
  const labeledChineseVisit = phiScrub("就诊时间：2026年7月18日14:35；主诉失眠");
  assert.doesNotMatch(labeledChineseVisit, /2026年7月18日|14:35/, phiTag("a labeled Chinese visit time must not leak the clock time"));
  assert.match(labeledChineseVisit, /就诊时间：\[已泛化\]/);
  const bareDateProbe = phiScrub("2026-07-18 突发胸痛");
  assert.doesNotMatch(bareDateProbe, /2026-07-18/, phiTag("a bare date is a quasi-identifier on both paths"));
  assert.match(bareDateProbe, /\[日期已泛化\]/);
  assert.match(phiScrub("2026年3月发病，反复咳嗽"), /2026年3月/, phiTag("year-month onset text is clinically needed and must stay intact"));
  // (d) identifiers buried mid-record: scrub runs before any truncation on both paths.
  const phiFiller = "患者诉反复失眠多梦，伴心烦心悸，纳食尚可，二便调，夜寐不安。";
  const longRecord = `${phiFiller.repeat(9)}患者家住朝阳区望京西园四区，2026-07-18 14:35 突发胸痛，${phiFiller.repeat(9)}`;
  assert.ok(longRecord.length > 500, phiTag("the long-record probe must exceed 500 chars"));
  const scrubbedLongRecord = phiScrub(longRecord);
  assert.doesNotMatch(scrubbedLongRecord, /望京西园|2026-07-18|14:35/, phiTag("identifiers buried mid-record must be scrubbed"));
  assert.match(scrubbedLongRecord, /纳食尚可/, phiTag("long-record clinical content must survive"));
  // Idempotence: scrubbed markers must never be re-consumed by a second pass. The snapshot path
  // protects every marker, so its probe includes the address marker. On the model path the upstream
  // labeled-address recognizer (src/lib/diagnosis-safety.ts, frozen for this change) re-consumes
  // [地址已脱敏] on a second pass — a pre-existing limitation — so the model-path probe covers the
  // markers the shared layer fully owns (timestamps, bare dates, occupations).
  const idempotenceProbe = phiPathName === "model"
    ? "就诊时间：2026年7月18日14:35，从事教师工作，2026-07-18 复诊"
    : "患者家住朝阳区望京西园四区，就诊时间：2026年7月18日14:35，从事教师工作，2026-07-18 复诊";
  const scrubbedOnce = phiScrub(idempotenceProbe);
  assert.equal(phiScrub(scrubbedOnce), scrubbedOnce, phiTag("scrubbing must be idempotent"));
}
// 任职于… reaches the shared scrubber intact on the snapshot path; on the model path the upstream
// surname recognizer consumes 任职 first (src/lib/diagnosis-safety.ts is out of scope here), so the
// employer string 市博物馆 currently survives there — a documented residual of this change.
assert.match(scrubPersistentPhiText("任职于市博物馆，近3日失眠"), /任职于\[职业已泛化\]/, "snapshot path: 任职于… must generalize the employer");
assert.doesNotMatch(sanitizeFreeTextForModel("任职于市博物馆，近3日失眠"), /任职于市博物馆/, "model path: the anchored employer phrase must at least be broken up");
// (b) residual by design: 他是航天员大队教员 carries no anchor and is NOT regexed from prose
// (clinical false-positive risk). The field-level occupation is the authoritative mitigation.
assert.equal(
  sanitizeCaseStateForModel({ ...createInitialCaseState(), patient: { occupation: "航天员大队教员" } }).patient.occupation,
  "[职业已泛化]",
  "field-level rare occupation titles must be generalized before model egress",
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
assert.equal(duplicatedCompleteness.level, "B", "主诉复制到现病史且只有默认四诊时必须优先追问，不能伪装成C级");
for (const chiefComplaint of ["感冒", "头痛", "失眠", "乏力"]) {
  const singleLine = {
    ...createInitialCaseState(),
    chiefComplaint,
    symptoms: {},
  };
  assert.equal(deriveOperationalCompleteness(singleLine).level, "B", `${chiefComplaint}单行主诉应是可追问的B级，而不是A或C级`);
}
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
const severeHypertensionFlags = detectProgrammaticRedFlags(severeHypertensionWithoutTargetOrganSymptoms).join("\n");
assert.match(severeHypertensionFlags, /血压 190\/122mmHg.*规范复测.*评估急性靶器官损害/);
assert.doesNotMatch(severeHypertensionFlags, /已发生(?:卒中|心肌梗死|高血压脑病)|确诊.*靶器官损害/,
  "重度血压必须进入安全路径，但无症状时不得臆造已经发生具体靶器官事件");
assert.doesNotMatch(measuredVitalAdvisories(severeHypertensionWithoutTargetOrganSymptoms).join("\n"), /190\/122/,
  "已进入确定性红旗的同一血压不得再重复成第二条普通 advisory");
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
// 日期必须相对当前动态生成，不能写死。写死的「2026年8月1日」在编写时是遥远未来，
// 到了 2026-07-31 就变成次日，落进「当日/近日急诊已排除」窗口而被合理消解——测试随之
// 无故转红。当日排除消解红旗是既定安全设计（另有独立用例覆盖），这里要验证的是
// **与本次发作不匹配的日期（过去或明显未来）不得消解当前红旗**。
const pastYear = new Date().getFullYear() - 1;
const farFutureYear = new Date().getFullYear() + 1;
for (const text of [
  `2小时前突发胸痛伴大汗；${pastYear}年6月1日，已由心内科评估排除急性冠脉事件。`,
  `2小时前突发胸痛伴大汗；${pastYear}年6月1日患者曾在外院就诊，已由心内科评估排除急性冠脉事件。`,
  `2小时前突发胸痛伴大汗；${farFutureYear}年8月1日，已由急诊评估排除急性冠脉事件。`,
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
for (const tongue of ["边有齿印", "齿痕舌", "舌边齿痕", "舌边可见齿印", "舌体胖大，边缘有齿痕"]) {
  assert.equal(isUnknownClinicalFieldText(tongue, "tongue"), false, `documented tongue variant must be recognized: ${tongue}`);
}
for (const pulse of ["浮紧脉", "脉来浮而紧", "脉象为弦细", "脉沉兼迟", "脉见滑数"]) {
  assert.equal(isUnknownClinicalFieldText(pulse, "pulse"), false, `documented pulse variant must be recognized: ${pulse}`);
}
const crossFieldUnknownTongue = stateFromRecord("舌象待核实，现服阿司匹林100mg每日一次。", {
  zhushu: "睡眠差", tcmTongue: "舌象待核实，现服阿司匹林100mg每日一次", tcmPulse: "脉弦细",
  sex: "男", guomin: "否认药物过敏", yongyaoshi: "现服阿司匹林100mg每日一次",
});
assert.match(evaluateSafetyGate(crossFieldUnknownTongue).missingItems.join("、"), /舌象/);

const thunderclapEmergency = stateFromRecord(
  "今日突发人生最剧烈头痛，伴恶心呕吐，既往无类似发作。",
  {
    zhushu: "突发人生最剧烈头痛伴恶心呕吐",
    sex: "女",
    age: "36岁",
    tcmTongue: "舌边齿痕",
    tcmPulse: "脉来浮而紧",
    guomin: "否认药物及食物过敏",
    yongyaoshi: "目前无正在使用的中西药或保健品",
  },
);
thunderclapEmergency.patient = { sex: "女", age: 36 };
thunderclapEmergency.tongue = "舌边齿痕";
thunderclapEmergency.pulse = "脉来浮而紧";
const thunderclapGate = evaluateSafetyGate(thunderclapEmergency);
assert.equal(thunderclapGate.status, "red_flag");
assert.match(thunderclapGate.redFlagFindings?.[0]?.sourceQuote || "", /最剧烈头痛/);
const thunderclapAttestations = (thunderclapGate.redFlagFindings || []).map((finding) => ({
  ruleId: finding.ruleId,
  message: finding.message,
  disposition: "excluded_by_objective_workup",
  basis: "已完成头颅CT与神经系统查体，未见蛛网膜下腔出血或局灶体征",
}));
const clearedThunderclap = {
  ...thunderclapEmergency,
  emergencyClearance: {
    redFlagFingerprint: redFlagClearanceFingerprint(thunderclapGate),
    confirmedAt: "2026-07-28T08:00:00.000Z",
    assessmentSummary: "急诊影像及神经系统评估已排除急性神经血管事件",
    findings: thunderclapAttestations,
    contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  },
};
// 甲方 ⑫⑤：内容判据此前只有 assessmentSummary 的字数，一句废话即可清空全部确定性红旗。
// 安全门这一处与签发端跑同一个导出谓词，因此在这里也必须拦得住。
assert.equal(
  evaluateSafetyGate({
    ...clearedThunderclap,
    emergencyClearance: { ...clearedThunderclap.emergencyClearance, findings: undefined },
  }).status,
  "red_flag",
  "缺少逐条处置留痕的排查确认不得解除急诊拦截",
);
assert.equal(
  evaluateSafetyGate({
    ...clearedThunderclap,
    emergencyClearance: {
      ...clearedThunderclap.emergencyClearance,
      assessmentSummary: "今天天气不错今天天气不错今天天气不错",
      findings: thunderclapAttestations.map((item) => ({ ...item, basis: "今天天气不错今天天气不错" })),
    },
  }).status,
  "red_flag",
  "客观依据里没有做过的事时，排查确认不得解除急诊拦截",
);
const clearedThunderclapGate = evaluateSafetyGate(clearedThunderclap);
assert.notEqual(clearedThunderclapGate.status, "red_flag", "doctor clearance bound to the current findings should restore the ordinary workflow");
assert.equal(clearedThunderclapGate.allowDiagnosis, true);
assert.equal(
  evaluateSafetyGate({
    ...clearedThunderclap,
    emergencyClearance: { ...clearedThunderclap.emergencyClearance, redFlagFingerprint: "RF-STALE000" },
  }).status,
  "red_flag",
  "a stale or fabricated clearance fingerprint must never release an emergency block",
);
const changedEmergency = stateFromRecord(
  "今日突发人生最剧烈头痛，伴恶心呕吐，随后又出现压榨性胸痛伴冷汗。",
  {
    ...thunderclapEmergency.hisRecord.fields,
    zhushu: "突发最剧烈头痛后出现压榨性胸痛伴冷汗",
  },
);
changedEmergency.patient = { sex: "女", age: 36 };
changedEmergency.emergencyClearance = clearedThunderclap.emergencyClearance;
assert.equal(
  evaluateSafetyGate(changedEmergency).status,
  "red_flag",
  "a newly added emergency finding must invalidate the previously recorded clearance",
);

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
const mixedHeadacheSource = stateFromRecord(
  "头疼头晕、入睡困难2个月，多梦易醒；否认突发最剧烈头痛、复视、言语不清、肢体无力、喷射性呕吐。",
  { zhushu: "头疼头晕，睡不着觉" },
);
const exactGroundedRuleOut = "否认突发最剧烈头痛、复视、言语不清、肢体无力、喷射性呕吐";
const preservedGroundedSupport = sanitizeUngroundedRedFlagNegations([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    stage: "diagnose",
    westernDiagnosis: {
      primary: {
        name: "头痛症状",
        supportingFacts: ["头疼头晕，睡不着觉", exactGroundedRuleOut],
      },
    },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), mixedHeadacheSource);
const preservedGroundedSupportJson = JSON.parse(
  preservedGroundedSupport.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim(),
);
assert.deepEqual(
  preservedGroundedSupportJson.westernDiagnosis.primary.supportingFacts,
  ["头疼头晕，睡不着觉", exactGroundedRuleOut],
  "exact provenance-bearing support facts must remain byte-stable after output sanitization",
);
assert.doesNotMatch(
  preservedGroundedSupportJson.westernDiagnosis.primary.supportingFacts.join("；"),
  /病历已记录头痛阳性/,
  "a qualified headache rule-out must not be expanded into a contradictory positive assertion",
);
const partialGrounded = sanitizeUngroundedRedFlagNegations("患者无胸痛、头痛。", stateFromRecord("患者否认胸痛。", { zhushu: "睡眠差" }));
assert.match(partialGrounded, /否认胸痛/);
assert.doesNotMatch(partialGrounded, /头痛.*待核实|阴性史待核实/);
assert.match(partialGrounded, /病历尚未确认头痛是否存在/);
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
  assert.match(differentialNegations, new RegExp(term), `${term} must remain visible only as a specific unconfirmed boundary`);
}
assert.doesNotMatch(differentialNegations, /阴性史待核实|未记录|待核实/);
assert.match(differentialNegations, /病历尚未确认.*是否存在/);

const documentedNormal = stateFromRecord("本次肌酐与eGFR检查后，肾功能正常。", { zhushu: "复查" });
const insomniaSynonyms = stateFromRecord("入睡困难，多梦易醒，醒后再睡困难。", { zhushu: "入睡困难、多梦易醒3个月" });
const preservedInsomniaSynonyms = sanitizeUngroundedRedFlagNegations("患者失眠、早醒，病程3个月。", insomniaSynonyms);
assert.match(preservedInsomniaSynonyms, /患者失眠、早醒/);
assert.doesNotMatch(preservedInsomniaSynonyms, /阳性表现未在本次病历中明确记录/);
const colloquialSleepLatency = stateFromRecord(
  "躺床上脑子停不下来，得一两个小时才睡着。",
  { zhushu: "躺床上脑子停不下来，得一两个小时才睡着" },
);
const sanitizedSleepResolution = sanitizeUngroundedRedFlagNegations([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    stage: "diagnose",
    overview: {
      primarySyndromeResolution: "bounded",
      primarySyndromeResolutionReason: "病历尚未确认入睡困难是否存在。",
    },
    pathogenesis: {
      locationDifferentiation: {
        items: [],
        resolution: "unresolved",
        resolutionReason: "病历尚未确认入睡困难是否存在。",
      },
    },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), colloquialSleepLatency);
const sanitizedSleepResolutionJson = JSON.parse(
  sanitizedSleepResolution.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim(),
);
for (const reason of [
  sanitizedSleepResolutionJson.overview.primarySyndromeResolutionReason,
  sanitizedSleepResolutionJson.pathogenesis.locationDifferentiation.resolutionReason,
]) {
  assert.doesNotMatch(reason, /尚未确认入睡困难是否存在/);
  assert.match(reason, /已在病历中明确记录|有限判断/);
}
const twiceSanitizedSleepResolution = sanitizeUngroundedRedFlagNegations(sanitizedSleepResolution, colloquialSleepLatency);
assert.equal(
  twiceSanitizedSleepResolution,
  sanitizedSleepResolution,
  "bounded M03 resolution reasons must remain byte-idempotent across pre-review and pre-signature grounding",
);
const colloquialNightSweat = stateFromRecord("夜里总出汗，睡醒后才发现汗湿，睡不好一个月。", { zhushu: "夜里总出汗，睡不好一个月" });
const preservedNightSweatConcept = sanitizeUngroundedRedFlagNegations("患者盗汗，伴睡眠不佳。", colloquialNightSweat);
assert.match(preservedNightSweatConcept, /患者盗汗/);
assert.doesNotMatch(preservedNightSweatConcept, /盗汗阳性表现未在本次病历中明确记录/);
const colloquialDiarrhea = stateFromRecord("最近吃点东西就想跑厕所，稀稀的有半个月。", { zhushu: "吃东西后跑厕所，大便稀" });
const preservedDiarrheaConcept = sanitizeUngroundedRedFlagNegations("患者无发热、腹痛或腹泻。", colloquialDiarrhea);
assert.match(preservedDiarrheaConcept, /病历已记录腹泻阳性/, "colloquial loose-stool phrases must ground the canonical diarrhoea concept");
for (const documentedAbdominalPain of [
  "来月经第一天肚子疼得蜷着，热水袋捂着好点。",
  "小肚子一阵一阵地痛。",
  "肚脐周围隐隐疼。",
  "上腹持续疼了两天。",
]) {
  const abdominalState = stateFromRecord(documentedAbdominalPain, { zhushu: documentedAbdominalPain });
  const preservedAbdominalPain = sanitizeUngroundedRedFlagNegations("患者腹痛，局部喜温喜按。", abdominalState);
  assert.match(preservedAbdominalPain, /患者腹痛/, `${documentedAbdominalPain} must ground the canonical abdominal-pain concept`);
  assert.doesNotMatch(preservedAbdominalPain, /尚未确认腹痛/);
  assert.match(
    sanitizeUngroundedRedFlagNegations("病历尚未确认腹痛是否存在。", abdominalState),
    /病历已记录腹痛阳性/,
    "a documented colloquial abdominal-pain complaint cannot be weakened into an unknown canonical symptom",
  );
}
for (const deniedAbdominalPain of ["肚子一点也不疼。", "没有小腹痛。"]) {
  assert.doesNotMatch(
    sanitizeUngroundedRedFlagNegations("病历尚未确认腹痛是否存在。", stateFromRecord(deniedAbdominalPain, { zhushu: deniedAbdominalPain })),
    /病历已记录腹痛阳性/,
    `${deniedAbdominalPain} must not be promoted to positive abdominal pain`,
  );
}
for (const documentedConstipation of [
  "大便老解不出来，四五天一次。",
  "排便很费劲，每3天1次。",
  "隔三天才解一次大便。",
  "一周只有两次排便。",
]) {
  const preservedConstipationConcept = sanitizeUngroundedRedFlagNegations(
    "病历尚未确认便秘是否存在。",
    stateFromRecord(documentedConstipation, { zhushu: documentedConstipation }),
  );
  assert.match(preservedConstipationConcept, /病历已记录便秘阳性/, `${documentedConstipation} must ground the canonical constipation concept`);
  assert.doesNotMatch(preservedConstipationConcept, /尚未确认便秘/);
}
assert.doesNotMatch(preservedDiarrheaConcept, /尚未确认腹泻/, "an affirmed colloquial symptom must never be rewritten as unknown");
const localizedItching = stateFromRecord("鼻子眼睛都痒，没有发热、脸痛和黄脓鼻涕。", { zhushu: "喷嚏、清鼻涕，鼻子眼睛都痒" });
const preservedItchingConcept = sanitizeUngroundedRedFlagNegations("病历尚未确认瘙痒是否存在。", localizedItching);
assert.match(preservedItchingConcept, /病历已记录瘙痒阳性/, "localized nose/eye itching must ground the broader itching concept");
assert.doesNotMatch(preservedItchingConcept, /尚未确认瘙痒/, "a documented localized symptom cannot be rewritten as an unknown broader symptom");
for (const [canonical, colloquial] of [
  ["咳嗽", "感冒好了还一直干咳"],
  ["呼吸困难", "活动后喘不上气"],
  ["心悸", "这两天总是心慌、心跳快"],
  ["胸闷", "胸口发闷像堵着"],
  ["恶心", "饭后反胃想吐"],
  ["呕吐", "昨晚吐了两次"],
  ["便秘", "四五天一次，大便难解"],
]) {
  const groundedConcept = sanitizeUngroundedRedFlagNegations(
    `病历尚未确认${canonical}是否存在。`,
    stateFromRecord(colloquial, { zhushu: colloquial }),
  );
  assert.match(groundedConcept, new RegExp(`病历已记录${canonical}阳性`), `${colloquial} must ground ${canonical}`);
  assert.doesNotMatch(groundedConcept, new RegExp(`尚未确认${canonical}`));
}
const colloquialProductiveCough = stateFromRecord("早上老咳一口白痰，吸烟多年。", { zhushu: "早上老咳一口白痰" });
assert.match(
  sanitizeUngroundedRedFlagNegations("病历尚未确认咳嗽是否存在。", colloquialProductiveCough),
  /病历已记录咳嗽阳性/,
  "a verb-style productive-cough record must ground the canonical cough concept",
);
const coughCheckContent = [
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    westernDiagnosis: {
      primary: {
        limitations: ["病历尚未确认咳嗽是否存在。", "吸烟年限仍需核实"],
        suggestedChecks: ["病历尚未确认咳嗽是否存在。", "必要时行肺功能检查"],
      },
    },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");
const sanitizedCoughCheck = JSON.parse(
  sanitizeUngroundedRedFlagNegations(coughCheckContent, colloquialProductiveCough)
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.deepEqual(sanitizedCoughCheck.westernDiagnosis.primary.limitations, ["吸烟年限仍需核实"]);
assert.deepEqual(sanitizedCoughCheck.westernDiagnosis.primary.suggestedChecks, ["必要时行肺功能检查"]);
const duplicatedClinicalLists = JSON.parse(
  sanitizeUngroundedRedFlagNegations([
    "<!-- DIAGNOSIS_JSON_START -->",
    JSON.stringify({
      westernDiagnosis: {
        primary: {
          limitations: ["病历尚未确认头痛是否存在。", " 病历尚未确认头痛是否存在 ", "需补充颈部查体"],
          suggestedChecks: ["颈部查体；", "颈部查体", "必要时影像学评估"],
        },
      },
      management: { mustCollect: ["舌象、脉象", "舌象、脉象。", "疼痛加重缓解因素"] },
    }),
    "<!-- DIAGNOSIS_JSON_END -->",
  ].join("\n"), stateFromRecord("低头看手机多，脖子僵。", { zhushu: "脖子僵" }))
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.deepEqual(duplicatedClinicalLists.westernDiagnosis.primary.limitations, ["病历尚未确认头痛是否存在。", "需补充颈部查体"]);
assert.deepEqual(duplicatedClinicalLists.westernDiagnosis.primary.suggestedChecks, ["颈部查体；", "必要时影像学评估"]);
assert.deepEqual(duplicatedClinicalLists.management.mustCollect, ["舌象、脉象", "疼痛加重缓解因素"]);
const exertionalWheeze = stateFromRecord("跑快了胸口呼呼响，晚上有时会憋醒。", { zhushu: "跑快了胸口呼呼响" });
assert.match(
  sanitizeUngroundedRedFlagNegations("病历尚未确认呼吸困难是否存在。", exertionalWheeze),
  /病历已记录呼吸困难阳性/,
  "colloquial exertional wheeze must prevent the respiratory manifestation from being relabelled unknown",
);
const wheezeDifferentialContent = [
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    westernDiagnosis: {
      differentials: [{
        name: "心功能不全",
        reason: "当前仅列为鉴别方向",
        nextCheck: "病历尚未确认呼吸困难是否存在。",
      }],
    },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");
const sanitizedWheezeDifferential = JSON.parse(
  sanitizeUngroundedRedFlagNegations(wheezeDifferentialContent, exertionalWheeze)
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.equal(
  sanitizedWheezeDifferential.westernDiagnosis.differentials[0].nextCheck,
  "结合已记录的呼吸困难，进一步评估严重度、诱发因素及必要检查",
);
const colloquialHeadache = stateFromRecord("右边脑袋一跳一跳地疼，见光就烦。", { zhushu: "右边脑袋一跳一跳地疼" });
assert.match(
  sanitizeUngroundedRedFlagNegations("病历尚未确认头痛是否存在。", colloquialHeadache),
  /病历已记录头痛阳性/,
  "a colloquial location-and-quality headache description must ground the canonical headache concept",
);
const tightBandHeadache = stateFromRecord("最近天天头上像戴了个紧箍，脖子也酸。", { zhushu: "头上像戴了个紧箍" });
assert.match(
  sanitizeUngroundedRedFlagNegations("病历尚未确认头痛是否存在。", tightBandHeadache),
  /病历已记录头痛阳性/,
  "a tight-band head complaint must not be weakened into an unknown headache",
);
const qualifiedHeadacheDenial = stateFromRecord(
  "头痛5天，头痛如裹，肢体困重。否认突发雷击样头痛、发热和意识异常。",
  { zhushu: "头痛5天" },
);
const preservedQualifiedHeadacheDenial = sanitizeUngroundedRedFlagNegations(
  "本例否认突发雷击样头痛、发热和意识异常。",
  qualifiedHeadacheDenial,
);
assert.match(preservedQualifiedHeadacheDenial, /否认突发雷击样头痛、发热和意识异常/);
assert.doesNotMatch(
  preservedQualifiedHeadacheDenial,
  /病历已记录头痛阳性.*病历已记录否认头痛/,
  "qualified thunderclap denial must never collapse into the contradictory generic denial of headache",
);
const reconciledQualifiedHeadacheDenial = sanitizeUngroundedRedFlagNegations(
  "病历已记录头痛阳性；病历已记录否认头痛、发热。",
  qualifiedHeadacheDenial,
);
assert.match(reconciledQualifiedHeadacheDenial, /病历已记录头痛阳性/);
assert.match(reconciledQualifiedHeadacheDenial, /否认突发雷击样头痛、发热和意识异常/);
assert.doesNotMatch(reconciledQualifiedHeadacheDenial, /病历已记录否认头痛(?:、|。|；|$)/);
const headacheUncertaintyContent = [
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    pathogenesis: {
      uncertainties: [{ item: "头痛", reason: "病历尚未确认头痛是否存在。", affects: "影响病情评估" }],
    },
    management: { mustCollect: ["病历尚未确认头痛是否存在。", "进一步询问头痛伴随表现"] },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");
const sanitizedHeadacheUncertainty = JSON.parse(
  sanitizeUngroundedRedFlagNegations(headacheUncertaintyContent, colloquialHeadache)
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.deepEqual(sanitizedHeadacheUncertainty.pathogenesis.uncertainties, [], "an uncertainty row contradicted by a documented positive fact is removed instead of rewritten into a false known-state explanation");
assert.deepEqual(sanitizedHeadacheUncertainty.management.mustCollect, ["进一步询问头痛伴随表现"]);
const sanitizedFollowupSafetyNet = JSON.parse(
  sanitizeUngroundedRedFlagNegations([
    "<!-- DIAGNOSIS_JSON_START -->",
    JSON.stringify({ management: { followupSafetyNet: "病历尚未确认头痛是否存在。" } }),
    "<!-- DIAGNOSIS_JSON_END -->",
  ].join("\n"), colloquialHeadache)
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.match(sanitizedFollowupSafetyNet.management.followupSafetyNet, /病历已记录头痛阳性/);
assert.match(sanitizedFollowupSafetyNet.management.followupSafetyNet, /持续不缓解.*及时复诊/);
assert.match(sanitizedFollowupSafetyNet.management.followupSafetyNet, /立即急诊评估/);
const twiceSanitizedFollowupSafetyNet = JSON.parse(
  sanitizeUngroundedRedFlagNegations([
    "<!-- DIAGNOSIS_JSON_START -->",
    JSON.stringify(sanitizedFollowupSafetyNet),
    "<!-- DIAGNOSIS_JSON_END -->",
  ].join("\n"), colloquialHeadache)
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.equal(
  twiceSanitizedFollowupSafetyNet.management.followupSafetyNet,
  sanitizedFollowupSafetyNet.management.followupSafetyNet,
  "conditional follow-up triggers must remain idempotent across M03 and M04 output grounding",
);
assert.match(twiceSanitizedFollowupSafetyNet.management.followupSafetyNet, /立即急诊评估/);
const colloquialNeurologicNegations = stateFromRecord(
  "右边脑袋一跳一跳地疼；不是突然最痛，没有发热、手脚无力和说话不清。",
  { zhushu: "右边脑袋一跳一跳地疼" },
);
const reconciledNeurologicNegations = sanitizeUngroundedRedFlagNegations(
  "病历尚未确认言语不清、肢体无力是否存在。",
  colloquialNeurologicNegations,
);
assert.match(reconciledNeurologicNegations, /病历已记录否认言语不清、肢体无力/);
assert.doesNotMatch(reconciledNeurologicNegations, /尚未确认(?:言语不清|肢体无力)/);
for (const [canonical, documentedDenials] of [
  ["呕血", ["没吐过血。", "否认吐血。", "没有呕出鲜血。", "没吐咖啡色液体。"]],
  ["黑便", ["没有大便发黑。", "否认排黑色便。", "没解过柏油样便。"]],
  ["便血", ["没有大便带血。", "否认血便。", "没解过血便。"]],
  ["咯血", ["没有咳血。", "否认咳出血。"]],
]) {
  for (const documentedDenial of documentedDenials) {
    const reconciledBleedingNegation = sanitizeUngroundedRedFlagNegations(
      `病历尚未确认${canonical}是否存在。`,
      stateFromRecord(documentedDenial, { zhushu: "复诊评估" }),
    );
    assert.match(
      reconciledBleedingNegation,
      new RegExp(`病历已记录否认${canonical}`),
      `${documentedDenial} must ground the denied ${canonical} concept`,
    );
    assert.doesNotMatch(
      reconciledBleedingNegation,
      new RegExp(`尚未确认${canonical}`),
      `${documentedDenial} must not be weakened from negative to unknown`,
    );
  }
}
assert.match(
  sanitizeUngroundedRedFlagNegations("患者无呕血。", stateFromRecord("没吐过血。", { zhushu: "餐后上腹胀" })),
  /患者无呕血/,
  "a canonical model denial supported by a colloquial chart denial must survive output grounding",
);
for (const deniedRadiation of [
  "疼痛不往腿上窜。",
  "腰痛未向下肢放射。",
  "疼只在腰上，没有串到腿上。",
]) {
  const reconciledRadiationNegation = sanitizeUngroundedRedFlagNegations(
    "病历尚未确认放射痛是否存在。",
    stateFromRecord(deniedRadiation, { zhushu: "搬东西后腰酸痛" }),
  );
  assert.match(reconciledRadiationNegation, /病历已记录否认放射痛/, `${deniedRadiation} must ground the denied radiation-pain concept`);
  assert.doesNotMatch(reconciledRadiationNegation, /尚未确认放射痛/);
}
const documentedRadiationPain = stateFromRecord("腰痛向下肢放射，一直窜到小腿。", { zhushu: "腰痛向下肢放射" });
assert.match(
  sanitizeUngroundedRedFlagNegations("病历尚未确认放射痛是否存在。", documentedRadiationPain),
  /病历已记录放射痛阳性/,
  "documented radiation pain must be reconciled as positive rather than negative or unknown",
);
const conditionalRadiationPain = stateFromRecord("如果疼痛向下肢放射，请及时就诊。", { zhushu: "腰酸痛" });
assert.match(
  sanitizeUngroundedRedFlagNegations("病历尚未确认放射痛是否存在。", conditionalRadiationPain),
  /病历尚未确认放射痛是否存在/,
  "a conditional safety-net phrase must not become a patient assertion",
);
const knownConstipationWithUnknownAttributes = stateFromRecord(
  "大便老解不出来，四五天一次，肚子还胀。",
  { zhushu: "大便老解不出来，四五天一次" },
);
for (const unknownAttribute of [
  "便秘相关的粪便性状、排便费力程度未记录。",
  "病历未记录便秘相关细节。",
  "既往史、用药史与便秘相关诱因未记录。",
]) {
  const preservedAttributeGap = sanitizeUngroundedRedFlagNegations(unknownAttribute, knownConstipationWithUnknownAttributes);
  assert.equal(preservedAttributeGap, unknownAttribute, `a known constipation diagnosis must not erase its unknown attribute: ${unknownAttribute}`);
  assert.doesNotMatch(preservedAttributeGap, /该症状已在病历中明确记录|病历已记录便秘阳性/);
}
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
const traceableInstruction = normalizeExternalEvidenceResponse("instruction", {
  data: [{ drugName: "某药说明书", approvalNumber: "国药准字Z12345678", manufacturer: "某药企", summary: "适应证文本" }],
});
assert.equal(traceableInstruction.length, 1, "an instruction with product identity and approval number remains traceable");
assert.deepEqual({
  sourceKind: traceableInstruction[0].sourceKind,
  title: traceableInstruction[0].title,
  publisher: traceableInstruction[0].publisher,
  identifier: traceableInstruction[0].identifier,
  medicineName: traceableInstruction[0].medicineName,
  indication: traceableInstruction[0].indication,
}, {
  sourceKind: "instruction",
  title: "某药说明书",
  publisher: "某药企",
  identifier: "国药准字Z12345678",
  medicineName: "某药说明书",
  indication: "适应证文本",
});
assert.match(traceableInstruction[0].fingerprint || "", /^sha256:[a-f0-9]{64}$/);

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
  decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日1剂；冷水浸泡30分钟；煎煮2次；合并约400mL；早晚分服；夜交藤同煎", course: "5日", followUpNode: "5日复诊" },
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
assert.equal(doseMods.length, 0, "已实际编辑的药味只存在于 candidate.herbs，不得复制成带剂量的条件性加减");
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
  dosesPerDay: 1,
  administrationTimesPerDay: 2,
  followUpAfterDoses: 5,
  followUpAfterDays: 5,
};
assert.equal(prescriptionRegimenFromDecoction(structuredRegimen)?.dosesPerDay, 1, "structured regimen values are authoritative when display prose omits repeated numbers");
assert.equal(prescriptionRegimenFromDecoction({ ...structuredRegimen, method: "" }), null, "structured dose count must not hide an empty administration method");
assert.equal(prescriptionRegimenFromDecoction({ ...structuredRegimen, followUpNode: "" }), null, "structured follow-up numbers must not hide an empty follow-up instruction");
assert.equal(prescriptionRegimenFromDecoction({ ...structuredRegimen, dosesPerDay: 2 }), null);
assert.equal(prescriptionRegimenFromDecoction({ ...structuredRegimen, followUpAfterDoses: 4 }), null);
assert.equal(prescriptionRegimenFromDecoction({ ...structuredRegimen, followUpAfterDays: 7 }), null);
assert.equal(prescriptionRegimenFromDecoction({ ...processedSynchronized.decoction, followUpNode: "30日后复诊" }), null);
assert.equal(prescriptionRegimenFromDecoction({ ...processedSynchronized.decoction, followUpNode: "完成4剂后复诊" }), null);
for (const followUpNode of ["0天后复诊", "1天后复诊", "4天后复诊", "6天后复诊", "7天后复诊"]) {
  assert.equal(prescriptionRegimenFromDecoction({ ...processedSynchronized.decoction, followUpNode }), null);
}
const filteredMods = filterModificationsForEditedHerbs([
  { trigger: "多梦", targetPathogenesis: "心神不宁", action: "加夜交藤", doseOrHandling: "15g", reason: "安神", riskNote: "" },
  { trigger: "情志不舒", targetPathogenesis: "肝郁", action: "加", herbName: "合欢皮", doseOrHandling: "12g", reason: "解郁", riskNote: "" },
], originalCandidate.herbs, editedHerbs);
assert.equal(filteredMods.length, 0, "删除与新增均由当前候选和 revision 记录，不得残留为条件性加减");
const normalizedLegacyMods = filterModificationsForEditedHerbs([
  { trigger: "健忘仍明显", targetPathogenesis: "心神失养", action: "加茯神", doseOrHandling: null, reason: "宁心安神", riskNote: "实际采用时重新审方" },
], originalCandidate.herbs, editedHerbs);
assert.equal(normalizedLegacyMods[0].action, "加", "a newly signed doctor edit must not reproduce the legacy combined action field");
assert.equal(normalizedLegacyMods[0].herbName, "茯神");
const synthesizedMods = filterModificationsForEditedHerbs([], originalCandidate.herbs, editedHerbs);
assert.equal(synthesizedMods.length, 0, "工作台实际新增药味不得另行合成 formula.modifications 编辑日志");
const versionReasoning = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  formula: { candidates: [synchronized], modifications: normalizedLegacyMods },
};
const versionHash = await computePrescriptionVersionHash(versionReasoning, 0);
assert.match(versionHash, /^sha256-[a-f0-9]{64}$/);
assert.equal(await computePrescriptionVersionHash(versionReasoning, 0), versionHash);
assert.notEqual(await computePrescriptionVersionHash({ ...versionReasoning, formula: { ...versionReasoning.formula, modifications: [{ ...normalizedLegacyMods[0], reason: "变更后的加味原因" }] } }, 0), versionHash);
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
const strongRiskFollowupState = {
  ...followUpState,
  riskAssessment: "## 合理用药审方\n**最高提示强度**：强提示\n**审方结论**：需调整后复核",
};
assert.equal(hasStrongPrescriptionRisk(strongRiskFollowupState), true);
assert.match(deriveFirstReviewTiming(strongRiskFollowupState, hasStrongPrescriptionRisk(strongRiskFollowupState)), /当日复核/);
const followupAuthoringSource = readFileSync(new URL("../src/lib/m05-followup-authoring.server.ts", import.meta.url), "utf8");
assert.match(followupAuthoringSource, /deriveFirstReviewTiming\(state, hasStrongPrescriptionRisk\(state\)\)/,
  "共享 M05 作者的首次复诊时间必须与最终强提示同源");
for (const route of ["assess", "post-prescription-risk", "his-scheme"]) {
  const source = readFileSync(new URL(`../src/app/api/diagnosis/${route}/route.ts`, import.meta.url), "utf8");
  assert.match(source, /authorFollowupForCase/, `${route} 必须消费共享 M05 作者`);
  assert.doesNotMatch(source, /deriveFirstReviewTiming\(assessed, false\)/);
}

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

const typedFollowupFrames = [
  { type: "followup_timeline", timelineItems: [{ time: "3日后", action: "复诊", indicators: ["睡眠时长"], triggers: ["失眠加重时提前复诊"] }] },
  { content: "## 随访管理方案\n请按计划复诊。" },
  { content: "[END]" },
].map((frame) => `${JSON.stringify(frame)}\n`).join("");
const typedFollowupResult = await consumeMarkdownStreamWithMetadata(new Response(typedFollowupFrames), () => undefined);
assert.equal(typedFollowupResult.content, "## 随访管理方案\n请按计划复诊。");
assert.deepEqual(typedFollowupResult.followupTimeline, [{
  time: "3日后",
  action: "复诊",
  indicators: ["睡眠时长"],
  triggers: ["失眠加重时提前复诊"],
}], "typed follow-up frames must reach the client as structured data instead of a dead channel");

const complaintPollutedReferenceFrames = [
  { content: "## 辨病辨证\n临床正文。" },
  {
    quto: [
      "主诉：入睡困难、多梦易醒3个月",
      "入睡困难，多梦易醒，醒后再睡困难",
      { title: "患者反复头晕3天，转头时明显" },
      { literatureTitle: "中国成人失眠诊断与治疗指南", journal: "中华神经科杂志", author: "中华医学会神经病学分会", year: "2023" },
      { title: "失眠症诊断和治疗指南", doi: "10.1234/example.2024.01" },
    ],
  },
  { content: "[END]" },
].map((frame) => `${JSON.stringify(frame)}\n`).join("");
const complaintSafeReferenceResult = await consumeMarkdownStream(
  new Response(complaintPollutedReferenceFrames),
  () => undefined,
);
assert.match(complaintSafeReferenceResult, /## 参考文献/);
assert.match(complaintSafeReferenceResult, /中国成人失眠诊断与治疗指南/);
assert.match(complaintSafeReferenceResult, /10\.1234\/example\.2024\.01/);
assert.doesNotMatch(
  complaintSafeReferenceResult.split("## 参考文献")[1] || "",
  /主诉|入睡困难，多梦易醒，醒后再睡困难|患者反复头晕3天/,
  "patient complaints and retrieval queries must never be repackaged as references",
);

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

console.log(JSON.stringify({ cases: 169, failures: 0 }));

// ─── 程度副词/弱化量词重组不构成编造（2026-07 甲方妇科病例实测的类）───
// 长枚举句病历里，模型引用几乎必然发生副词压缩：「经量较前明显增多」→「经量增多」、
// 「夹有少许血块」→「夹有血块」。这是同一事实的合理压缩，原字面检查却按编造驳回，
// 唯一的妇科病例因此反复 patient_fact_ungrounded_*_literal。
// 边界：告警性量词（大量/骤增）与否定词不剥——病历写少许、模型写大量必须仍拒。
{
  const { m03SafetyContractIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
  const context = "近1个月月经周期提前至22天即来潮，经量较前明显增多，色紫红，夹有少许血块，伴心烦易怒。";
  const mk = (fact) => ({
    stage: "diagnose",
    overview: { primarySyndrome: "血热证", overallPathogenesis: "阳盛血热，热扰冲任" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: fact, syndromeEvidence: "心烦易怒", pathogenesis: "阳盛血热，热扰冲任", therapyDirection: "清热凉血，固冲调经" }] },
    therapy: { overallPrinciple: "热者清之", overallMethod: "清热凉血，固冲调经" },
    management: { followupSafetyNet: "若经量骤增不止或头晕乏力，应及时就诊复查。" },
    formula: null,
  });
  for (const fact of ["经量增多", "经量较前增多", "夹有血块", "月经周期提前至22天，经量增多"]) {
    assert.equal(m03SafetyContractIssue(mk(fact), context), undefined,
      `合理压缩的事实「${fact}」必须接地成功`);
  }
  for (const fact of ["夹有大量血块", "经量骤增", "带下量多色黄"]) {
    assert.match(m03SafetyContractIssue(mk(fact), context) || "",
      /patient_fact_ungrounded/,
      `「${fact}」升级或编造了病历没有的表述，必须仍拒`);
  }
}
