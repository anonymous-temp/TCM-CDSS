import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { buildEvidenceOutputTransform } from "../src/lib/cdss-evidence-context.ts";

const jiti = createJiti(import.meta.url);
const { synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

// 回归 #7：证据 URL/括号ID 的文本剥离绝不能破坏 sentinel JSON 块。此前 URL 正则会吃掉块内 JSON 字符串的
// 闭合引号 → JSON.parse 失败 → 结构化解析与反伪造双双失效。块内证据须由结构化路径降级，块外才做文本剥离。
const evidenceContext = [
  "## 官方基础依据",
  "- [OFFICIAL-RX-REVIEW] 《医疗机构处方审核规范》 https://allowed.example.gov/ok",
  `- [EVID-INST-001] 药名：已核验候选｜适应证：失眠｜条目指纹：sha256:${"1".repeat(64)}｜URL:https://allowed.example.gov/medicine`,
].join("\n");
const transform = buildEvidenceOutputTransform(evidenceContext);

const content = [
  "组方依据：见 https://evil.com/fabricated 与 [FAKE-ID-123]。",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify(
    {
      schemaVersion: "tcm-cdss-reasoning-v2",
      stage: "diagnose",
      evidence: [{ evidenceLevel: "guideline", source: "https://evil.com/fabricated 伪造指南" }],
      note: '含引号相邻URL: "https://evil.com/x"',
    },
    null,
    2,
  ),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");

const out = transform(content);
const block = out.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/);
assert.ok(block, "sentinel 块应仍存在");
let parsed;
assert.doesNotThrow(() => { parsed = JSON.parse(block[1]); }, "块内应仍是合法 JSON(未被 URL 剥离破坏)");
assert.equal(parsed.evidence[0].evidenceLevel, "insufficient", "越界URL证据应被结构化降级为 insufficient");
const outside = out.split("DIAGNOSIS_JSON_START")[0];
assert.ok(!outside.includes("evil.com"), "块外越界URL应被剥离");
assert.ok(!outside.includes("FAKE-ID-123"), "块外伪ID应被剥离");
console.log("PASS  #7 sentinel JSON 块在证据剥离后仍合法，越界证据结构化降级，块外剥离生效");

const medicineContent = [
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    formula: {
      // 夹具补齐为 schema 完整条目（2026-08-11）。此前只写了证据相关字段，缺
      // type/specification/usageBoundary/course/positioning/relationship/riskNote，
      // 是一条 PatentAndWesternSchema 判否、逐条隔离必然剔除的候选——它当年能出现在
      // 医生页面上，只是因为可见正文读的是**归一之前**的原始载荷。
      // 现在投影前先归一（页面只显示载荷里真实存在的内容），这条不完整夹具会一并消失，
      // 而那正是线上应有的行为。本套件要验的是**证据净化**，不是 schema 容忍度，故补全夹具。
      patentAndWestern: [
        { name: "伪来源药物", type: "中成药", specification: null, usageBoundary: "遵医嘱", course: "3日", positioning: "需医生评估", correspondingProblem: "失眠", relationship: "不与饮片默认联用", riskNote: "需复核", evidence: { evidenceLevel: "guideline", source: "https://evil.com/fabricated" } },
        { name: "借用通用政策的药物", type: "中成药", specification: null, usageBoundary: "遵医嘱", course: "3日", positioning: "需医生评估", correspondingProblem: "失眠", relationship: "不与饮片默认联用", riskNote: "需复核", evidence: { evidenceLevel: "guideline", source: "[OFFICIAL-RX-REVIEW]" } },
        { name: "已核验候选", type: "中成药", specification: null, usageBoundary: "遵说明书", course: "7日", positioning: "替代方案", correspondingProblem: "失眠", relationship: "与饮片方案不默认联用", riskNote: "服药期间忌浓茶", evidenceId: "EVID-INST-001", evidenceFingerprint: `sha256:${"1".repeat(64)}`, recommendationMode: "candidate_review", evidence: { evidenceLevel: "instruction", source: "[EVID-INST-001]" } },
      ],
    },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");
const medicineOut = transform(medicineContent);
const medicineBlock = medicineOut.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/);
assert.ok(medicineBlock);
const medicineParsed = JSON.parse(medicineBlock[1]);
assert.deepEqual(medicineParsed.formula.patentAndWestern.map((item) => item.name), ["已核验候选"], "具体药物必须由提及该药的说明书/指南/文献支持，不能借用通用政策文件");
console.log("PASS  具体西药/中成药仅保留本次证据范围内可核验的候选");

const visibleMedicineOut = synchronizeVisibleClinicalSummary(medicineOut, "prescribe");
assert.ok(!visibleMedicineOut.includes("伪来源药物"), "用户可见报告不得泄露结构化过滤前的未核验药物名称");
assert.ok(visibleMedicineOut.includes("已核验候选"), "用户可见报告应保留本次证据范围内可核验的候选");
console.log("PASS  用户可见报告与净化后的结构化西药/中成药候选保持一致");

const clinicalSemanticInput = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndromeBasis: ["夜间出汗伴入睡困难1个月", "当前资料不足以支持寒热虚实"],
  },
  pathogenesis: {
    locationDifferentiation: { resolution: "unresolved", resolutionReason: "资料不足，病位暂不归属" },
    natureDifferentiation: { basis: "资料不足", resolution: "unresolved", resolutionReason: "寒热虚实资料不足" },
    uncertainties: [{ item: "舌脉", reason: "本轮资料不足", affects: "影响证型" }],
  },
  westernDiagnosis: { differentials: [{ name: "继发原因", reason: "当前资料不足以满足标准" }] },
  evidence: { evidenceLevel: "insufficient", source: "内部证据缺口", confidence: "低" },
};
const clinicalSemanticOut = transform([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify(clinicalSemanticInput),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const clinicalSemanticBlock = clinicalSemanticOut.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/);
assert.ok(clinicalSemanticBlock);
const clinicalSemanticParsed = JSON.parse(clinicalSemanticBlock[1]);
assert.deepEqual(clinicalSemanticParsed.overview, clinicalSemanticInput.overview, "evidence cleanup must preserve reviewed syndrome bases");
assert.deepEqual(clinicalSemanticParsed.pathogenesis, clinicalSemanticInput.pathogenesis, "evidence cleanup must preserve reviewed resolution and uncertainty text");
assert.deepEqual(clinicalSemanticParsed.westernDiagnosis, clinicalSemanticInput.westernDiagnosis, "evidence cleanup must preserve reviewed differentials");
assert.equal(clinicalSemanticParsed.evidence.source, "", "internal insufficient-evidence source remains hidden without rewriting clinical fields");
console.log("PASS  证据净化不再改写已复核的临床语义字段");

const optionalModificationOut = transform([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    formula: {
      candidates: [{ name: "本例辨证组方", herbs: [{ name: "黄芪", dose: "15g" }] }],
      modifications: [
        { trigger: "乏力加重", targetPathogenesis: "气虚", action: "加党参", reason: "" },
        { trigger: "夜寐不安", targetPathogenesis: "心神不宁", action: "加", herbName: "酸枣仁", reason: "加强养心安神" },
      ],
    },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const optionalModificationBlock = optionalModificationOut.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/);
assert.ok(optionalModificationBlock);
const optionalModificationParsed = JSON.parse(optionalModificationBlock[1]);
assert.equal(optionalModificationParsed.formula.modifications.length, 1, "evidence cleanup prunes an unusable optional modification instead of invalidating the core prescription");
assert.equal(optionalModificationParsed.formula.modifications[0].action, "加");
assert.equal(optionalModificationParsed.formula.modifications[0].herbName, "酸枣仁");
console.log("PASS  证据净化后不可用的可选加减行不会拖垮核心处方");
console.log("5/5 passed");
