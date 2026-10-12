// M03/M04 输出瘦身（2026-10-12）。用户问「锁定方、候选方案是否重复、环节太多」，实测耗时几乎全在模型
// 逐字写出（~150–175 tok/s），于是逐字段量了 15 例的写出量与去向，把服务端本来就会覆盖、推出或无人读的
// 字段从模型输出里拿掉，可见文字加了字数上限。本套件钉住：
//   · 下发给模型的 schema 不再含这些字段；模型按旧习惯照写不算违规（否则会触发 24s 的严格兜底），
//     唯独 deferredFormulaSelection 必须被剥掉——它是服务端锁定的留痕，模型写了会让系统锁定被跳过；
//   · 服务端补齐：总治法复制、分治方向按病机链投影、药味 targetKind 由 targetRef 推出、
//     中成药/西药行按 evidenceId 从同一说明书条目补齐（补出的行仍过说明书绑定校验）；
//   · 精简提案与完整写法编译出逐字相同的临床结果；
//   · M04 提示词带上西医支持事实（加减规则要求读它，此前却没给）；不限定流派时要求 lineageAdaptation 为 null；
//   · 提示词里不再有「不得删短」的反向规则。
//   · M04 只是位置写错的 JSON（提案级字段进了 candidate、调护字段落到根上、越界的治疗项目）在入口确定性归位，
//     不再整份交给严格兜底重生成；服务端病机提示被截半后不重复追加。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const {
  providerJsonSchemaForTask, structuredOutputSchemaInstruction, checkNonStrictStructuredValue,
} = await jiti.import("../src/lib/model-response-format.ts");
const { mergeParallelM03Halves } = await jiti.import("../src/lib/m03-parallel-merge.ts");
const { applyServerOwnedM03Fields } = await jiti.import("../src/lib/m03-server-owned-fields.ts");
const { applyM03AdvisoryQualityBoundaries, applyDeterministicTreatmentPrinciple } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const { compileM04Proposal, compileM04JsonObjectContent } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { instructionRecordPoolFromText, fillMedicineRowFromInstructionRecord } = await jiti.import("../src/lib/instruction-record-pool.ts");
const { formatLocalPatentMedicineRecord } = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
const { formatInstructionEvidenceRecord } = await jiti.import("../src/lib/evimed-guide.ts");
const { buildEvidenceScope, medicineEvidenceBindingValid } = await jiti.import("../src/lib/evidence-source-validation.ts");
const { SERVER_PATHOGENESIS_NO_MECHANISM_NOTE } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { buildPrescribePrompt, buildDiagnosePrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");

/** 收集 schema 里出现的属性名（跳过 default 注解：那是 zod 兜底值，不约束输出）。 */
function propertyNames(schema) {
  const out = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    for (const [key, child] of Object.entries(node)) {
      if (key === "default") continue;
      if (key === "properties" && child && typeof child === "object") for (const name of Object.keys(child)) out.add(name);
      visit(child);
    }
  };
  visit(schema);
  return out;
}

const M03_TCM_SERVER_DERIVED = [
  "recommendedFormulaNames", "formulaSelectionMode", "deferredFormulaSelection", "tcmDiseaseReferences",
  "tcmSyndromeReferences", "overallTherapy", "caseRelationship", "resolutionReason", "nodeId",
  "pathogenesisType", "biaoBen", "subTherapies", "alternativeDirection",
];

test("M03 provider schemas no longer ask the model for server-derived fields", () => {
  for (const task of ["m03_tcm", "m03_full"]) {
    const names = propertyNames(providerJsonSchemaForTask(task));
    for (const key of M03_TCM_SERVER_DERIVED) assert.equal(names.has(key), false, `${task} still asks for ${key}`);
    for (const key of ["primarySyndrome", "primarySyndromeResolutionReason", "recommendedFormulaDirection", "chain", "therapyDirection", "overallMethod", "uncertainties"]) {
      assert.equal(names.has(key), true, `${task} lost clinical field ${key}`);
    }
  }
  const western = providerJsonSchemaForTask("m03_western");
  const names = propertyNames(western);
  for (const key of ["coding", "citation", "url"]) assert.equal(names.has(key), false, `western half still asks for ${key}`);
  for (const key of ["supportingFacts", "supportingFactKinds", "guidelineReferences", "evidenceId", "appliesTo", "differentials", "candidates"]) {
    assert.equal(names.has(key), true, `western half lost ${key}`);
  }
  // 鉴别项的引用由服务端逐项重写：鉴别项定义里不再有 guidelineReferences，主诊断那一处保留。
  const differentialDefs = Object.values(western.$defs || {}).filter((def) =>
    def?.properties && ["name", "reason", "distinguishingPoints", "nextCheck"].every((key) => key in def.properties));
  assert.ok(differentialDefs.length > 0);
  for (const def of differentialDefs) assert.equal("guidelineReferences" in def.properties, false);
});

test("the DeepSeek schema instruction drops zod default annotations", () => {
  for (const task of ["m03_tcm", "m03_western"]) {
    const instruction = structuredOutputSchemaInstruction("deepseek-flash", task);
    assert.ok(instruction.length > 0);
    assert.doesNotMatch(instruction, /"default"/);
    assert.doesNotMatch(instruction, /尚未形成稳定证型/);
  }
});

const tcmHalf = () => ({
  overview: {
    tcmDiseaseName: "泄泻", primarySyndrome: "脾胃虚弱证", primarySyndromeResolution: "bounded",
    primarySyndromeBasis: ["食少倦怠", "大便溏薄"], primarySyndromeResolutionReason: "缺舌脉",
    tcmDiseaseRationale: "以大便溏薄为主，归入泄泻。", tcmDiagnosticRationale: "食少倦怠故病位在脾，便溏故属气虚夹湿。",
    tcmDifferentials: [{ syndrome: "湿热泄泻", typicalManifestation: "泻下急迫，肛门灼热", reason: "同为泄泻", distinguishingPoints: "本例无灼热", nextCheck: null }],
    tcmDiseaseDifferentials: [{ diseaseName: "痢疾", typicalManifestation: "里急后重，便下脓血", reason: "同见便次增多", distinguishingPoints: "本例无脓血", nextCheck: null }],
    secondarySyndromes: [], overallPathogenesis: "脾胃虚弱，运化失司，湿浊下注。",
    recommendedFormulaDirection: "参苓白术散加减",
  },
  pathogenesis: {
    locationDifferentiation: { items: ["脾"], details: [{ location: "脾", basis: "食少倦怠" }], resolution: "bounded" },
    natureDifferentiation: { items: ["气虚"], rootDeficiency: ["气虚"], branchExcess: [], basis: "食少倦怠", resolution: "bounded" },
    symptomClusters: [],
    chain: [
      { patientFact: "食少倦怠", syndromeEvidence: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" },
      { patientFact: "大便溏薄", syndromeEvidence: "大便溏薄", pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" },
    ],
    uncertainties: [{ item: "舌脉", reason: "未记录舌脉", affects: "寒热判断" }],
  },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气，化湿止泻" },
  lineageAdaptation: null,
});

test("a TCM half in the new compact shape is schema-clean", () => {
  const check = checkNonStrictStructuredValue("m03_tcm", tcmHalf());
  assert.deepEqual(check.violations, []);
  assert.deepEqual(check.repairs, []);
});

test("old-habit keys are tolerated, but a model-written deferredFormulaSelection is stripped", () => {
  const habit = tcmHalf();
  Object.assign(habit.overview, { recommendedFormulaNames: ["参苓白术散"], formulaSelectionMode: "single", overallTherapy: "健脾益气，化湿止泻", tcmDiseaseReferences: [] });
  habit.pathogenesis.chain = habit.pathogenesis.chain.map((node, index) => ({ nodeId: `P${index + 1}`, pathogenesisType: "始动", ...node }));
  habit.pathogenesis.caseRelationship = { rootPattern: "脾虚", mainManifestation: "泄泻", relationship: "脾虚生湿" };
  habit.pathogenesis.locationDifferentiation.resolutionReason = "缺舌脉";
  habit.therapy.subTherapies = [{ therapy: "健脾益气", targetPathogenesis: "脾胃虚弱", priority: "主要" }];
  const tolerated = checkNonStrictStructuredValue("m03_tcm", habit);
  assert.deepEqual(tolerated.violations, [], "habitual keys must not push the half onto the 24s strict fallback");
  assert.deepEqual(tolerated.repairs, []);

  const forged = tcmHalf();
  forged.overview.deferredFormulaSelection = { direction: "参苓白术散加减", names: ["参苓白术散"], mode: "single", reason: "system_retrieved_governed_lock" };
  const stripped = checkNonStrictStructuredValue("m03_tcm", forged);
  assert.deepEqual(stripped.violations, []);
  assert.ok(stripped.repairs.some((item) => item.includes("deferredFormulaSelection")), JSON.stringify(stripped.repairs));
  assert.equal(JSON.parse(stripped.content).overview.deferredFormulaSelection, undefined);
});

test("the half merge drops a model-written deferredFormulaSelection and keeps every clinical field", () => {
  const half = tcmHalf();
  half.overview.deferredFormulaSelection = { direction: "x", names: ["参苓白术散"], mode: "single", reason: "system_retrieved_governed_lock" };
  const merged = JSON.parse(mergeParallelM03Halves(JSON.stringify(half), JSON.stringify({ westernDiagnosis: { primary: { name: "腹泻，病因待查" } }, management: {} })));
  assert.equal(merged.overview.deferredFormulaSelection, undefined);
  assert.equal(merged.overview.recommendedFormulaDirection, "参苓白术散加减");
  assert.equal(merged.overview.primarySyndrome, "脾胃虚弱证");
});

const wrap = (value) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(value)}\n<!-- DIAGNOSIS_JSON_END -->`;
const unwrap = (content) => JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));

test("server fills overallTherapy from overallMethod without overriding a model value", () => {
  const filled = unwrap(applyServerOwnedM03Fields(wrap({ stage: "diagnose", ...tcmHalf() })));
  assert.equal(filled.overview.overallTherapy, "健脾益气，化湿止泻");
  const kept = tcmHalf();
  kept.overview.overallTherapy = "模型自己写的总治法";
  assert.equal(unwrap(applyServerOwnedM03Fields(wrap({ stage: "diagnose", ...kept }))).overview.overallTherapy, "模型自己写的总治法");
});

test("sub-therapies are projected from the pathogenesis chain when the model no longer writes them", () => {
  const filled = applyServerOwnedM03Fields(wrap({ stage: "diagnose", ...tcmHalf() }));
  const projected = unwrap(applyM03AdvisoryQualityBoundaries(filled, "食少倦怠，大便溏薄")).therapy.subTherapies;
  assert.deepEqual(projected.map((item) => [item.therapy, item.targetPathogenesis, item.priority]), [
    ["健脾益气", "脾胃虚弱，运化无力", "主要"],
    ["健脾化湿", "脾虚湿盛", "次要"],
  ]);
});

// ── M04 ─────────────────────────────────────────────────────────────────────────────

const prior = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome: "脾胃虚弱证", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  westernDiagnosis: { primary: { name: "功能性腹泻", supportingFacts: ["大便溏薄3月", "腹部隐痛"] }, differentials: [] },
  pathogenesis: { chain: [
    { nodeId: "P1", patientFact: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" },
    { nodeId: "P2", patientFact: "大便溏薄", pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" },
  ] },
  therapy: { overallMethod: "健脾益气，化湿和中", overallPrinciple: "虚则补之" },
};
const fullHerbs = [
  { name: "党参", dose: "12g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "补脾益气", processing: null, isToxic: false, decoctionRequirement: null },
  { name: "白术", dose: "10g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾燥湿", processing: null, isToxic: false, decoctionRequirement: null },
  { name: "茯苓", dose: "12g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾渗湿", processing: null, isToxic: false, decoctionRequirement: null },
  { name: "炙甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "调和诸药", processing: null, isToxic: false, decoctionRequirement: null },
];
const compactHerbs = [
  { name: "党参", dose: "12g", role: "君", targetRef: "P1", function: "补脾益气" },
  { name: "白术", dose: "10g", role: "臣", targetRef: "P2", function: "健脾燥湿" },
  { name: "茯苓", dose: "12g", role: "佐", targetRef: "P2", function: "健脾渗湿" },
  { name: "炙甘草", dose: "6g", role: "使", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "调和诸药" },
];
const proposal = (herbs, patentAndWestern = []) => ({
  candidate: {
    name: "本例辨证组方", herbs,
    formulaAnalysis: "党参为君补脾益气，白术为臣健脾燥湿，茯苓为佐渗湿止泻，炙甘草为使调和诸药。",
    decoction: { doseCount: "6剂", dosesPerDay: 1, administrationTimesPerDay: 2 },
  },
  patentAndWestern,
  modifications: [],
  nonPharma: { diet: "早餐可用山药小米粥，少量多餐。", lifestyle: "规律作息。", emotion: "保持心情舒畅。", tcmTreatments: [], precautions: [] },
});

test("herbs without targetKind/processing/isToxic/decoctionRequirement compile identically to the full form", () => {
  const full = compileM04Proposal(proposal(fullHerbs), prior);
  const compact = compileM04JsonObjectContent(JSON.stringify(proposal(compactHerbs)), prior);
  assert.ok(full, "full form must compile");
  assert.ok(compact, "compact form must compile");
  // 比 JSON 往返后的值：签名载荷与三出口都是序列化后的 JSON，值为 undefined 的键在不在没有区别。
  assert.deepEqual(JSON.parse(JSON.stringify(compact)), JSON.parse(JSON.stringify(full)));
  assert.equal(compact.formula.candidates[0].herbs[0].targetKind, "pathogenesis_node");
  assert.equal(compact.formula.candidates[0].herbs[3].targetKind, "formula_structure");
});

test("a compact M04 proposal and the old full-row habit are both schema-clean", () => {
  const compactCheck = checkNonStrictStructuredValue("m04_proposal", proposal(compactHerbs, [
    { type: "中成药", evidenceId: "LOCAL-INST-001", correspondingProblem: "食少便溏", positioning: "替代方案" },
  ]));
  assert.deepEqual(compactCheck.violations, []);
  assert.deepEqual(compactCheck.repairs, [], "a four-key medicine row must not be dropped as invalid");
  const fullRow = {
    type: "中成药", name: "参苓白术丸", specification: "每袋6g", singleDose: null, frequency: null, route: null, administrationTiming: null,
    usageBoundary: "按说明书", course: null, positioning: "替代方案", correspondingProblem: "食少便溏", evidenceId: "LOCAL-INST-001",
    evidenceFingerprint: `sha256:${"a".repeat(64)}`, relationship: "择一", riskNote: "孕妇慎用",
  };
  const habitCheck = checkNonStrictStructuredValue("m04_proposal", proposal(fullHerbs, [fullRow]));
  assert.deepEqual(habitCheck.violations, []);
  assert.deepEqual(habitCheck.repairs, []);
});

const LOCAL_FINGERPRINT = `sha256:${"1".repeat(64)}`;
const EVID_FINGERPRINT = `sha256:${"2".repeat(64)}`;
const localRecord = formatLocalPatentMedicineRecord({
  id: "LOCAL-INST-001", name: "参苓白术丸", specification: "每袋装6g", approvalNumber: "国药准字Z00000000", manufacturer: "某药业",
  indication: "健脾、益气。用于体倦乏力，食少便溏。", matchedConcepts: ["便溏"], matchedPatientFacts: ["大便溏薄"],
  usage: "口服。一次6g，一日3次。", contraindication: "忌食生冷油腻", precaution: "感冒发热者不宜服用", children: "", elderly: "",
  pregnancyLactation: "孕妇慎用", interaction: "不宜与藜芦同用", fingerprint: LOCAL_FINGERPRINT, url: "",
});
const evidRecord = formatInstructionEvidenceRecord({
  medicineName: "蒙脱石散", publisher: "某制药", specification: "3g", indication: "成人及儿童急、慢性腹泻",
  usage: "口服，成人一次1袋，一日3次", contraindication: "对本品过敏者禁用", specialPopulation: "", interaction: "与其他药物间隔服用",
  fingerprint: EVID_FINGERPRINT, url: "",
}, "EVID-INST-101");
const promptText = `## 本地中成药说明书检索\n${localRecord}\n\n## EviMed 说明书检索\n${evidRecord}\n- [LOCAL-INST-009] 药名：无指纹药｜适应证：腹泻`;

test("the instruction record pool parses both record formats and skips rows without a fingerprint", () => {
  const pool = instructionRecordPoolFromText(promptText);
  assert.deepEqual([...pool.keys()].sort(), ["EVID-INST-101", "LOCAL-INST-001"]);
  const local = pool.get("LOCAL-INST-001");
  assert.equal(local.name, "参苓白术丸");
  assert.equal(local.specification, "每袋装6g");
  assert.equal(local.evidenceFingerprint, LOCAL_FINGERPRINT);
  assert.equal(local.type, "中成药");
  assert.match(local.riskNote, /孕妇慎用/);
  assert.match(local.riskNote, /藜芦/);
  assert.equal(pool.get("EVID-INST-101").name, "蒙脱石散");
});

test("model rows are completed from the same record and still pass the label binding check", () => {
  const pool = instructionRecordPoolFromText(promptText);
  const scope = buildEvidenceScope(promptText);
  const filled = fillMedicineRowFromInstructionRecord(
    { type: "中成药", evidenceId: "LOCAL-INST-001", correspondingProblem: "食少便溏", positioning: "替代方案", name: "模型写错的药名" },
    pool,
  );
  assert.equal(filled.name, "参苓白术丸", "label fields always come from the record, never from the model");
  assert.equal(filled.positioning, "替代方案");
  assert.equal(filled.correspondingProblem, "食少便溏");
  assert.equal(medicineEvidenceBindingValid(filled.evidenceId, filled.evidenceFingerprint, filled.name, filled.correspondingProblem, filled.specification, scope), true);
  const western = fillMedicineRowFromInstructionRecord({ type: "西药", evidenceId: "EVID-INST-101", correspondingProblem: "慢性腹泻", positioning: "短期对症" }, pool);
  assert.equal(western.type, "西药");
  assert.equal(medicineEvidenceBindingValid(western.evidenceId, western.evidenceFingerprint, western.name, western.correspondingProblem, western.specification, scope), true);
  const unknown = { type: "中成药", evidenceId: "LOCAL-INST-077", correspondingProblem: "便溏", positioning: "替代方案" };
  assert.equal(fillMedicineRowFromInstructionRecord(unknown, pool), unknown, "an ID the model never saw is left for the existing validation to drop");
});

test("compile keeps a four-key medicine row only when the record pool can complete it", () => {
  const row = { type: "中成药", evidenceId: "LOCAL-INST-001", correspondingProblem: "大便溏薄", positioning: "替代方案" };
  const caseState = { chiefComplaint: "大便溏薄3月", symptoms: { presentHistory: "食少倦怠，大便溏薄" }, patient: {}, conversation: [] };
  const withPool = compileM04Proposal(proposal(compactHerbs, [row]), prior, caseState, [], instructionRecordPoolFromText(promptText));
  const medicines = withPool.formula.patentAndWestern;
  assert.equal(medicines.length, 1);
  assert.equal(medicines[0].name, "参苓白术丸");
  assert.equal(medicines[0].evidenceFingerprint, LOCAL_FINGERPRINT);
  assert.match(medicines[0].riskNote, /孕妇慎用/);
  const withoutPool = compileM04Proposal(proposal(compactHerbs, [row]), prior, caseState);
  assert.equal(withoutPool.formula.patentAndWestern.length, 0, "an unbound row never reaches the doctor");
});

test("the M04 prompt carries the western supporting facts its modification rule tells the model to read", () => {
  const prompt = buildPrescribePrompt({
    id: "slim-1", patient: { sex: "女", age: 40 }, chiefComplaint: "大便溏薄3月", symptoms: {}, conversation: [],
    reasoningDiagnose: prior,
  });
  assert.match(prompt, /westernDiagnosis\.primary\.supportingFacts/);
  assert.match(prompt, /"supportingFacts":\["大便溏薄3月","腹部隐痛"\]/);
  assert.doesNotMatch(prompt, /不因追求简短删去个体化解释/);
  assert.doesNotMatch(prompt, /"evidenceFingerprint":"sha256:逐字复制/);
  assert.doesNotMatch(prompt, /不得因为要紧凑而省略字段、删短临床依据/);
});

test("the M03 prompt asks for a null lineageAdaptation only when no school is chosen", () => {
  const base = { id: "slim-2", patient: { sex: "女", age: 40 }, chiefComplaint: "大便溏薄3月", symptoms: { presentHistory: "食少倦怠" }, conversation: [] };
  const unrestricted = buildDiagnosePrompt(base);
  const school = buildDiagnosePrompt({ ...base, tcmLineagePreference: "support-yang" });
  assert.match(unrestricted, /本例 lineageAdaptation 输出 null/);
  assert.doesNotMatch(school, /本例 lineageAdaptation 输出 null/);
  assert.doesNotMatch(unrestricted, /不得因为要紧凑而省略字段、删短临床依据/);
  assert.doesNotMatch(unrestricted, /"recommendedFormulaNames":\[/);
});

test("a half-truncated server pathogenesis note is not appended twice", () => {
  const half = tcmHalf();
  // 「迫血妄行」不在病机谓词词表里，走「追加提示」分支；末尾是被后续净化截掉一半的旧提示（2026-10-12 本机实测形态）。
  half.overview.overallPathogenesis = "热伏冲任，迫血妄行（服务端提示：";
  const once = unwrap(applyDeterministicTreatmentPrinciple(wrap({ stage: "diagnose", ...half }))).overview.overallPathogenesis;
  assert.equal(once, `热伏冲任，迫血妄行${SERVER_PATHOGENESIS_NO_MECHANISM_NOTE}`);
  const twice = unwrap(applyDeterministicTreatmentPrinciple(wrap({ stage: "diagnose", ...half, overview: { ...half.overview, overallPathogenesis: once } }))).overview.overallPathogenesis;
  assert.equal(twice, once, "idempotent");
});

test("M04 position-only JSON drift is put back in place instead of regenerating the whole proposal", () => {
  const good = proposal(compactHerbs, [{ type: "中成药", evidenceId: "LOCAL-INST-001", correspondingProblem: "食少便溏", positioning: "替代方案" }]);
  // ① 提案级字段被写进 candidate 里
  const nested = structuredClone(good);
  for (const key of ["patentAndWestern", "modifications", "nonPharma"]) { nested.candidate[key] = nested[key]; delete nested[key]; }
  const lifted = checkNonStrictStructuredValue("m04_proposal", nested);
  assert.deepEqual(lifted.violations, []);
  assert.ok(lifted.repairs.includes("lifted_m04_proposal_field:patentAndWestern"), JSON.stringify(lifted.repairs));
  assert.deepEqual(JSON.parse(lifted.content), JSON.parse(JSON.stringify(good)));
  // ② nonPharma 提前闭合，其余调护字段落到根上
  const early = structuredClone(good);
  early.nonPharma = { diet: good.nonPharma.diet };
  for (const key of ["lifestyle", "emotion", "tcmTreatments", "precautions"]) early[key] = good.nonPharma[key];
  const regrouped = checkNonStrictStructuredValue("m04_proposal", early);
  assert.deepEqual(regrouped.violations, []);
  assert.deepEqual(JSON.parse(regrouped.content).nonPharma, good.nonPharma);
  // ③ 中医特色治疗项目代码越界：只删那一条
  const badTreatment = structuredClone(good);
  badTreatment.nonPharma.tcmTreatments = [{ projectCode: "NOT_A_CODE", targetRef: "P1" }];
  const dropped = checkNonStrictStructuredValue("m04_proposal", badTreatment);
  assert.deepEqual(dropped.violations, []);
  assert.deepEqual(JSON.parse(dropped.content).nonPharma.tcmTreatments, []);
  // 目标位置已有同名键时不动，照报
  const conflict = structuredClone(good);
  conflict.candidate.modifications = [];
  conflict.modifications = "not-an-array";
  assert.ok(checkNonStrictStructuredValue("m04_proposal", conflict).violations.length > 0);
});
