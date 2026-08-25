// ── 叙述字段覆盖率红线（2026-08-25 四维审查 C4/#10） ─────────────────────────────
//
// 查体断言净化的作用域是**按字段名白名单**（PHYSICAL_EXAM_ASSERTION_FIELDS）手工枚举的：
// 每加一个模型自由文本字段就天然多一个「模型写什么医生看什么」的洞，且类型系统与既有
// 测试都发现不了漏项。本套件遍历 ReasoningV2Schema 的全部字符串叶子键，
// 要求每个键 ∈ 查体白名单 ∪ 显式豁免表：
//   - 新增字段未登记任何一边 → 本套件红，强制作者当场归类；
//   - EXEMPT_FIELD_KEYS 是**已知裸奔字段的冻结清单**（P2 白名单翻转的工作清单），
//     只许随修复缩小，新增字段禁止直接进入本表（进来必须带豁免理由注释）。
// 与 test:governed-formula-lock「从写入端源码抽取取值真跑 schema」同一手法。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
const { PHYSICAL_EXAM_ASSERTION_FIELDS } = await jiti.import("../src/lib/diagnosis-safety.ts");

// 结构/标识/引用元数据类：值不是面向医生的自由叙述，查体净化对它们无意义。
const STRUCTURAL_EXEMPT = new Set([
  "schemaVersion", "stage", "contractSignatureVersion", "contractSignature", "nodeId", "targetRef",
  "name", "syndrome", "diseaseName", "herbName", "replaces", "substitute", "evidenceId", "citation",
  "url", "appliesTo", "source", "code", "display", "system", "status", "confidence", "dose",
  "doseCount", "method", "course", "frequency", "route", "specification", "singleDose",
  "administrationTiming", "administrationTimes", "targetKind", "role", "actionType", "trigger",
  "time", "action", "formulaSource", "constructionType", "formulaSelectionMode", "mode",
  "identityDeclassificationReason", "reviewIssueCode", "reviewDecision", "issueCode", "provider",
  "model", "reviewer", "payloadHash", "semanticHash", "attestedAt", "label", "note", "id",
  "namespace", "originalTerm", "standardTerm", "reason",
  // 术语/受控词表级（值受国标或受治理目录约束，非自由叙述）：
  "location", "branchExcess", "rootDeficiency", "tcmDiseaseName", "recommendedFormulaNames", "names",
  // 服务端自写或引用元数据（模型改不动或改了即失效）：
  "droppedReason", "fromModel", "toModel", "lineageCode", "message", "reviewedPayloadHash",
  "safetyDeference", "sourceRef", "unaffectedBySafety", "qualityAnnotationCodes", "waivedIssueCodes",
  // 剂量/引用原文（各有专属校验：PRECAUTION_DOSE_LIKE / 逐字接地）：
  "doseOrHandling", "sourceQuote",
]);

// 已知裸奔的叙述字段（2026-08-25 时点冻结；每修一个从这里删一个）。
const KNOWN_NAKED_NARRATIVE_FIELDS = new Set([
  "tcmDiseaseRationale", "overallTherapy", "recommendedFormulaDirection", "typicalManifestation",
  "pathogenesis", "therapyDirection", "item", "rootPattern", "mainManifestation", "relationship",
  "redFlagLoop", "applicable", "notApplicable", "therapyMatch", "formulaAnalysis",
  "targetPathogenesis", "riskNote", "diet", "lifestyle", "emotion", "acupointCare",
  "treatmentContent", "techniqueBoundary", "scheduleSuggestion", "protocolGap",
  "assessmentPositioning", "applicabilityReason", "detail", "alternativeDirection",
  "direction", "precaution", "function", "prescriptionRole", "compositionLogic",
  "discriminationPath", "overallPrinciple", "overallMethod", "therapy", "primarySyndrome",
  "overallPathogenesis", "primarySyndromeResolutionReason", "resolutionReason",
  "patientInstruction", "decoctionRequirement", "precautions", "mustCollect",
]);

function stringLeafKeys(schema, keys = new Set(), seen = new Set()) {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return keys;
  seen.add(schema);
  const def = schema._def || schema.def;
  const inner = def?.innerType || def?.schema || (typeof schema.unwrap === "function" ? (() => { try { return schema.unwrap(); } catch { return undefined; } })() : undefined);
  if (inner) stringLeafKeys(inner, keys, seen);
  if (def?.type === "object" || schema.shape) {
    const shape = typeof schema.shape === "function" ? schema.shape() : schema.shape;
    for (const [key, child] of Object.entries(shape || {})) {
      if (isStringLike(child)) keys.add(key);
      stringLeafKeys(child, keys, seen);
    }
  }
  const element = def?.element || schema.element;
  if (element) stringLeafKeys(element, keys, seen);
  for (const option of def?.options || []) stringLeafKeys(option, keys, seen);
  return keys;
}
function isStringLike(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 6) return false;
  const def = schema._def || schema.def;
  if (!def) return false;
  if (def.type === "string") return true;
  const inner = def.innerType || def.schema || (typeof schema.unwrap === "function" ? (() => { try { return schema.unwrap(); } catch { return undefined; } })() : undefined);
  if (inner && isStringLike(inner, depth + 1)) return true;
  return (def.options || []).some((option) => isStringLike(option, depth + 1));
}

const allStringKeys = stringLeafKeys(ReasoningV2Schema);
assert.ok(allStringKeys.size >= 40, `schema 遍历疑似失效：只找到 ${allStringKeys.size} 个字符串键`);
const uncovered = [...allStringKeys].filter((key) =>
  !PHYSICAL_EXAM_ASSERTION_FIELDS.has(key) && !STRUCTURAL_EXEMPT.has(key) && !KNOWN_NAKED_NARRATIVE_FIELDS.has(key));
assert.deepEqual(uncovered.sort(), [],
  `发现未登记的模型自由文本字段：${JSON.stringify(uncovered)}。` +
  "每个新叙述字段必须当场归类：进 PHYSICAL_EXAM_ASSERTION_FIELDS（获得查体断言净化）" +
  "或带豁免理由进入本套件的清单——不允许静默裸奔。");
console.log(JSON.stringify({ suite: "exam-claim-field-coverage", stringKeys: allStringKeys.size, whitelisted: PHYSICAL_EXAM_ASSERTION_FIELDS.size, knownNaked: KNOWN_NAKED_NARRATIVE_FIELDS.size, failures: 0 }));
