import type { CaseState, ClinicalReasoningResultV2, Completeness, HisRecordSnapshot, SafetyGate, SafetyMissingItemCode } from "./diagnosis-types";
import { sectionTitleGroup } from "./cdss-vocab";
import {
  assessConceptionState,
  assessLactationState,
  assessPregnancyState,
  isKnownClinicalState,
  isUnknownClinicalFieldText,
  isUnknownClinicalText,
  isPositiveOrPossibleClinicalState,
} from "./clinical-state";
import { generalizeOccupation, scrubQuasiIdentifierText } from "./phi-sanitizer";
import { determineCompletenessLevel } from "./diagnosis-parse";
import { additiveRedFlagsFromFacts, priorityEvaluationItemsFromFacts, semanticTriageAdvisoriesFromFacts } from "./clinical-facts";
import { clinicalEventTemporalScopeAt } from "./clinical-polarity";

function stringifyClinicalValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function flattenClinicalInput(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(flattenClinicalInput);
  if (typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(flattenClinicalInput);
}

export function isLimitedDiagnosisText(text: string | undefined): boolean {
  const t = text || "";
  // When M03 explicitly commits to "完整候选方案" as its 结论 (only permitted when the deterministic
  // completeness gate is C and no red flag), it produced a full candidate scheme. Do NOT let management
  // next-step narrative elsewhere in the report ("建议完善甲功后再评估" / "补齐现病史后再辨证") re-flag it
  // as limited and halt the chain — that intermittently re-broke prescription generation. Dose-level
  // safety stays independently governed by canEnterDosePrescriptionChain and the prescribe route gate.
  const conclusion = (t.replace(/\*/g, "").match(/结论[：:]\s*([^\n]+)/) || [])[1] || "";
  if (/完整候选方案/.test(conclusion)) return false;
  return /(信息不足建议模式|高风险安全建议模式|辨证信息完整度不足|暂不生成西医诊断|信息不足，?暂不生成|急危重症风险线索待排除|暂不(?:宜|进入|生成).{0,24}(?:方药|处方|候选方案|剂量)|不宜直接进入.{0,24}(?:剂量级|候选处方)|建议(?:先)?(?:补充|补齐|完善).{0,50}再(?:辨证|评估|处方|进入|开方)|(?:补充|补齐|完善).{0,50}后再(?:辨证|评估|处方|进入|开方)|证候锚点.{0,24}不足|病机链.{0,24}不足|缺少稳定证候锚点)/.test(t);
}

export function hasActionableM03Diagnosis(diagnosis?: string): boolean {
  const text = diagnosis?.trim() || "";
  if (!text || isLimitedDiagnosisText(text)) return false;
  return /(##\s*西医诊断|##\s*中医证候诊断|证候诊断|证候-病机关联|总体病机|子病机|中医辨证结论|完整候选方案)/.test(text);
}

function fieldText(state: CaseState, key: keyof HisRecordSnapshot["fields"]): string {
  return state.hisRecord?.fields?.[key] ?? "";
}

function latestUserMessage(state: CaseState): string {
  return [...state.conversation].reverse().find((item) => item.role === "user" && item.content.trim())?.content.trim() || "";
}

function allUserMessages(state: CaseState): string {
  return state.conversation
    .filter((item) => item.role === "user" && item.content.trim())
    .map((item) => item.content.trim())
    .join("\n");
}

function authoritativeFieldOrFallback(
  state: CaseState,
  key: keyof HisRecordSnapshot["fields"],
  fallback: unknown,
): string {
  const field = fieldText(state, key);
  if (state.hisRecord) return field;
  const latestUser = latestUserMessage(state);
  if (latestUser) {
    const candidate = stringifyClinicalValue(fallback).trim();
    return candidate && normalizeClinicalText(latestUser).includes(normalizeClinicalText(candidate)) ? candidate : "";
  }
  return stringifyClinicalValue(fallback);
}

function isKnownClinicalText(value: unknown): boolean {
  const text = stringifyClinicalValue(value).trim();
  return !isUnknownClinicalText(text);
}

function isKnownTongueClinicalText(value: unknown): boolean {
  return !isUnknownClinicalFieldText(value, "tongue");
}

function isKnownPulseClinicalText(value: unknown): boolean {
  return !isUnknownClinicalFieldText(value, "pulse");
}

export function trustedInputText(state: CaseState): string {
  const hisFieldText = Object.values(state.hisRecord?.fields || {})
    .map((value) => stringifyClinicalValue(value))
    .filter(Boolean)
    .join("\n");
  const userConversationText = allUserMessages(state);

  // Safety and grounding must be based on clinician/patient input, never on fields that an earlier
  // model stage inferred. In particular, a collect model can misread "否认胸痛，但突发晕厥" and put
  // chest pain into state.symptoms; feeding that model-derived value back into the deterministic gate
  // turns a negated symptom into a positive red flag. HIS text/fields and user messages are the
  // authoritative sources. Clinician-entered top-level fields remain authoritative even after a
  // follow-up message is appended: a conversation must not evict tongue, pulse, vitals or histories
  // that were already recorded in the form. The model-derived symptoms DTO is intentionally excluded
  // whenever a primary source exists.
  const currentHis = state.hisRecord
    ? [state.hisRecord.rawText, hisFieldText].filter(Boolean).join("\n")
    : "";
  // chiefComplaint is a clinician-entered source field, not a model inference. Keep it in the
  // grounding corpus even when a follow-up conversation exists; otherwise a compatibility caller
  // without an HIS snapshot can lose the very fact that M03 is expected to explain.
  const clinicianEnteredFields = [
    state.tongue ? `舌象：${stringifyClinicalValue(state.tongue)}` : "",
    state.tongueImageDesc ? `舌象图像复核：${stringifyClinicalValue(state.tongueImageDesc)}` : "",
    state.pulse ? `脉象：${stringifyClinicalValue(state.pulse)}` : "",
    state.faceNote ? `面象：${stringifyClinicalValue(state.faceNote)}` : "",
    ...flattenClinicalInput(state.vitals).map((value) => `生命体征：${value}`),
    state.pastHistory ? `既往史：${stringifyClinicalValue(state.pastHistory)}` : "",
    state.medicationHistory ? `用药史：${stringifyClinicalValue(state.medicationHistory)}` : "",
    state.allergyHistory ? `过敏史：${stringifyClinicalValue(state.allergyHistory)}` : "",
  ].filter(Boolean);
  const compatibilitySymptoms = currentHis.trim() || userConversationText.trim()
    ? []
    : flattenClinicalInput(state.symptoms);
  const authoritativeInput = [currentHis, ...compatibilitySymptoms, ...clinicianEnteredFields, userConversationText].filter(Boolean).join("\n");
  if (authoritativeInput.trim()) return [state.chiefComplaint, authoritativeInput].filter(Boolean).join("\n");

  return [
    state.chiefComplaint,
    ...flattenClinicalInput(state.symptoms),
    state.tongue,
    state.pulse,
    state.faceNote,
    ...flattenClinicalInput(state.vitals),
    state.pastHistory,
    state.medicationHistory,
    state.allergyHistory,
  ].filter(Boolean).join("\n");
}

export function clinicalGroundingText(state: CaseState): string {
  return trustedInputText(state);
}

const RED_FLAG_NEGATION_TERMS = [
  "胸痛", "胸闷", "心悸", "黑矇", "晕厥", "意识丧失", "意识改变",
  "呼吸困难", "气促", "大汗", "放射痛", "剧烈头痛", "头痛", "视物模糊", "发热", "寒战",
  "呕血", "吐血", "黑便", "大便发黑", "粪便发黑", "排黑色便", "柏油样便", "便血", "咯血", "阴道流血",
  "外伤出血", "出血不止", "大量出血", "急腹痛", "腹痛", "板状腹",
  "反跳痛", "抽搐", "言语不清", "肢体无力", "端坐呼吸", "喘憋",
  // 鉴别诊断中常被模型误写成“患者无”的非红旗事实；未问到同样只能标记待核实。
  "怕冷", "怕热", "消瘦", "突眼", "面色苍白", "头晕", "打鼾", "呼吸暂停",
  "日间嗜睡", "情绪低落", "焦虑", "烦躁", "五心烦热", "口干咽燥", "咽干",
  "胸胁满", "善太息", "纳差", "便溏", "皮疹", "瘙痒",
] as const;
const CLINICAL_NORMALITY_TERMS = [
  "肝功能", "肾功能", "甲状腺功能", "甲功", "血常规", "血红蛋白", "血糖", "血脂",
  "心电图", "肌钙蛋白", "血氧", "胸部影像", "头颅影像",
] as const;
const CLINICAL_POSITIVE_FACT_TERMS = [
  "胸痛", "胸闷", "心悸", "晕厥", "头痛", "视物模糊", "发热", "咳嗽", "气促", "呼吸困难",
  "腹痛", "恶心", "呕吐", "失眠", "入睡困难", "早醒", "盗汗", "潮热", "口苦", "口渴", "便秘", "腹泻",
] as const;
const POSITIVE_FACT_EQUIVALENT_GROUPS: readonly (readonly string[])[] = [
  ["失眠", "入睡困难", "难以入睡", "睡眠差", "睡眠障碍"],
  ["早醒", "易醒", "多梦易醒", "醒后再睡困难"],
  ["盗汗", "夜间出汗", "夜里出汗", "夜里总出汗", "睡后出汗", "睡着后出汗", "睡眠后出汗", "睡醒后才发现汗湿"],
];
const DEGREE_AFTER_NEGATOR = "(?:很|太|特别|十分|非常|明显|严重|剧烈|轻|重|持续|一直)";
const CLINICAL_NEGATION_CUE = new RegExp(`(否认|不是(?!${DEGREE_AFTER_NEGATOR})|并非(?!${DEGREE_AFTER_NEGATOR})|不曾|均无|均未见|未见|未诉|未出现|没有|不伴|无明显|无再发|未再发|(?:当前|目前|现阶段|患者|病人)?(?:从未有|未曾有|无)(?=[\\u4e00-\\u9fa5]))`);
const NEGATION_SCOPE_BREAK = /[，,](?:但|而|仍|却|同时|另有|随后|继而|突发|新发|出现|伴有)/;
const NON_SYMPTOM_NEGATION_OBJECT = /(?:诱因|原因|缓解|好转|改善|变化|异常检查)/;

function sourceDocumentsNegation(source: string, term: string): boolean {
  const normalized = normalizeClinicalText(source);
  for (const sentence of normalized.split(/[。；;\n]+/)) {
    let termIndex = sentence.indexOf(term);
    while (termIndex >= 0) {
      const before = sentence.slice(Math.max(0, termIndex - 24), termIndex);
      const negations = Array.from(before.matchAll(new RegExp(CLINICAL_NEGATION_CUE.source, "g")));
      const nearest = negations.at(-1);
      if (nearest?.index != null) {
        const between = before.slice(nearest.index + nearest[0].length);
        if (!NEGATION_SCOPE_BREAK.test(between) && !NON_SYMPTOM_NEGATION_OBJECT.test(between)) return true;
      }
      const after = sentence.slice(termIndex + term.length, termIndex + term.length + 10);
      if (new RegExp(`^(?:均)?(?:未见|未诉|未出现|否认|不是(?!${DEGREE_AFTER_NEGATOR})|并非(?!${DEGREE_AFTER_NEGATOR})|不曾|没有|无)`).test(after)) return true;
      termIndex = sentence.indexOf(term, termIndex + term.length);
    }
  }
  return false;
}

function freshAbsoluteDateInText(value: string, maxAgeDays = 30): boolean {
  const match = value.match(/(?:(\d{4})[-年\/](\d{1,2})[-月\/](\d{1,2})日?)/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return false;
  const ageDays = (Date.now() - timestamp) / 86_400_000;
  return ageDays >= -1 && ageDays <= maxAgeDays;
}

function sourceDocumentsCurrentNormality(source: string, term: string): boolean {
  const stale = /(既往|曾经|曾有|曾|陈旧|以前|之前|过去|当时|去年|上[周月次年]|前几[天日]|(?:\d+|[一二两三四五六七八九十半数几多])\s*(?:年|个月|月|周|天|日)前)/;
  const normal = /(正常|未见(?:明显)?异常|无(?:明显)?异常|阴性|未升高|参考范围内|功能良好)/;
  const abnormal = /(?:明显)?异常|升高|降低|阳性|受损|不全/;
  return normalizeClinicalText(source).split(/[。；;\n]+/).some((sentence) => {
    const isCurrent = /(?:本次|今日|今天|当前|目前|现查|此次)/.test(sentence) || freshAbsoluteDateInText(sentence);
    if (!isCurrent || stale.test(sentence)) return false;
    const groupedNormal = /(?:均|皆)[^，,。；;]{0,8}(?:正常|未见(?:明显)?异常|无(?:明显)?异常|阴性|未升高|参考范围内)/.test(sentence);
    return sentence.split(/[，,、]+/).some((clause) => {
      if (!clause.includes(term)) return false;
      const resultText = clause.slice(clause.indexOf(term) + term.length);
      const cleanedResult = resultText.replace(/未见(?:明显)?异常|无(?:明显)?异常/g, "正常");
      if (abnormal.test(cleanedResult)) return false;
      return normal.test(resultText) || groupedNormal;
    });
  });
}

function sourceDocumentsAffirmation(source: string, term: string): boolean {
  const normalized = normalizeClinicalText(source);
  const equivalents = POSITIVE_FACT_EQUIVALENT_GROUPS.find((group) => group.includes(term)) || [term];
  for (const sentence of normalized.split(/[。；;\n]+/)) {
    for (const equivalent of equivalents) {
      let index = sentence.indexOf(equivalent);
      while (index >= 0) {
        if (!isNegatedAt(sentence, index) && !/(待核实|待确认|不清楚|未知|不详|未采集|未说明)/.test(sentence)) return true;
        index = sentence.indexOf(equivalent, index + equivalent.length);
      }
    }
  }
  return false;
}

function sourceHasKnownTongue(source: string): boolean {
  return !isUnknownClinicalFieldText(source, "tongue");
}

function sourceHasKnownPulse(source: string): boolean {
  return !isUnknownClinicalFieldText(source, "pulse");
}

function sanitizeUngroundedNegationText(value: string, source: string): string {
  const sanitizeClause = (clause: string): string => {
    const negationProbe = clause
      .replace(/无明显(?:诱因|原因|缓解|好转|改善)/g, "")
      // “肢体无力” is a positive neurologic symptom. The lexical “无” is part of the symptom name,
      // not a negation cue; masking it here prevents the output scrubber from rewriting a grounded
      // post-stroke fact into the synthetic sentence “病历已记录肢体无力阳性”.
      .replace(/肢体无力/g, "肢体乏力");
    const prefix = clause.match(/^(\s*(?:[-*]>?\s*|>\s*|#{1,6}\s*)?(?:[^：:|]{1,24}[：:]\s*)?)/)?.[1] || "";
    const documentedPendingTests = CLINICAL_NORMALITY_TERMS.filter(
      (term) => clause.includes(term) &&
        /(?:待核实|待确认|待查|未提供|未记录|未完成|不详|未知)/.test(clause) &&
        sourceDocumentsCurrentNormality(source, term),
    );
    if (documentedPendingTests.length > 0) {
      return `${prefix}病历已记录本次${documentedPendingTests.join("、")}未见明显异常；是否复查由医生结合病情判断`;
    }
    const unrecordedButDocumentedPositive = RED_FLAG_NEGATION_TERMS.filter(
      (term) => clause.includes(term) &&
        /(?:未记录|未提及|未询问|未采集)/.test(clause) &&
        sourceDocumentsAffirmation(source, term),
    );
    if (unrecordedButDocumentedPositive.length > 0) {
      return `${prefix}病历已记录${unrecordedButDocumentedPositive.join("、")}阳性`;
    }
    if (CLINICAL_NEGATION_CUE.test(negationProbe)) {
      const contradictedPositive = RED_FLAG_NEGATION_TERMS.filter(
        (term) => clause.includes(term) && sourceDocumentsAffirmation(source, term),
      );
      const unknown = RED_FLAG_NEGATION_TERMS.filter(
        (term) => clause.includes(term) &&
          !sourceDocumentsNegation(source, term) &&
          !sourceDocumentsAffirmation(source, term),
      );
      if (contradictedPositive.length > 0 || unknown.length > 0) {
        const supported = RED_FLAG_NEGATION_TERMS.filter(
          (term) => clause.includes(term) && sourceDocumentsNegation(source, term),
        );
        return `${prefix}${[
          contradictedPositive.length > 0 ? `病历已记录${contradictedPositive.join("、")}阳性` : "",
          supported.length > 0 ? `病历已记录否认${supported.join("、")}` : "",
          unknown.length > 0 ? "本次主诉及伴随症状变化" : "",
        ].filter(Boolean).join("；")}`;
      }
    }
    const unsupportedNormality = CLINICAL_NORMALITY_TERMS.filter(
      (term) => clause.includes(term) &&
        /(正常|未见(?:明显)?异常|无(?:明显)?异常|阴性|未升高|参考范围内|功能良好)/.test(clause) &&
        !sourceDocumentsCurrentNormality(source, term),
    );
    if (unsupportedNormality.length > 0) {
      return `${prefix}相关检查结果以本次病历记录为准`;
    }
    if (/(?:患者|病人|主诉|自诉|症见|表现为|伴有|出现|可见|现有)/.test(clause)) {
      const unsupportedPositive = CLINICAL_POSITIVE_FACT_TERMS.filter(
        (term) => clause.includes(term) && !sourceDocumentsNegation(clause, term) && !sourceDocumentsAffirmation(source, term),
      );
      if (unsupportedPositive.length > 0) {
        return `${prefix}接诊时核实相关症状是否存在`;
      }
    }
    return clause;
  };
  const scoped = value.replace(/[，,](?=(?:但|而|仍|却|同时|另有|随后|继而|突发|新发|出现|伴有))/g, "；");
  let sanitized = scoped.split("\n").map((line) => {
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      return line.split("|").map((cell) => cell.replace(/[^。；;]+/g, sanitizeClause)).join("|");
    }
    return line.replace(/[^。；;]+/g, sanitizeClause);
  }).join("\n");
  if (!sourceHasKnownTongue(source)) {
    sanitized = sanitized.replace(/舌(?:质)?(?:淡|红|绛|紫|暗|胖|瘦|嫩|老|裂|齿痕|边红|尖红)[^，。；;\n|]{0,24}|苔(?:薄|厚|白|黄|腻|燥|润|剥|少|无)/g, "舌象待核实");
  }
  if (!sourceHasKnownPulse(source)) {
    sanitized = sanitized.replace(/脉(?:浮|沉|迟|数|滑|涩|弦|细|弱|濡|缓|紧|实|虚|微|洪|结|代|促){1,4}/g, "脉象待核实");
  }
  return sanitized;
}

function normalizedAgeLiteral(value: unknown): string {
  return String(value ?? "").trim().replace(/\s*岁$/, "");
}

function sanitizeAgeClaimText(value: string, state: CaseState): string {
  const patientAge = normalizedAgeLiteral(state.patient.age);
  const hisAge = normalizedAgeLiteral(state.hisRecord?.fields?.age);
  const conflict = Boolean(patientAge && hisAge && patientAge !== hisAge);
  const authoritativeAge = hisAge || patientAge;
  if (!authoritativeAge && !conflict) return value;
  return value.replace(
    /(?:具体)?年龄(?:信息)?(?:未提供|未记录|未录入|不详|未知|待核实|待确认|需补录)/g,
    conflict ? "年龄记录存在冲突，需医生核实" : `年龄已记录为${authoritativeAge}岁`,
  );
}

const FEMALE_ONLY_CLINICAL_CONTEXT = /(月经|经期|妊娠|孕产|孕妇|孕期|哺乳|备孕女性|女性[^。；，,]{0,8}备孕)/;

function isAuthoritativeMale(state: CaseState): boolean {
  const value = String(state.hisRecord?.fields?.sex || state.patient.sex || "").trim();
  return /^(?:男|男性|男童|m|male|man)$/i.test(value);
}

function sanitizePatientApplicableText(value: string, state: CaseState): string {
  if (!isAuthoritativeMale(state) || !FEMALE_ONLY_CLINICAL_CONTEXT.test(value)) return value;
  return value.split("\n").map((line) => {
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      return line.split("|").map((cell) => FEMALE_ONLY_CLINICAL_CONTEXT.test(cell) ? " 本例男性不适用 " : cell).join("|");
    }
    const headingPrefix = line.match(/^(#{1,6}\s*)/)?.[1] || "";
    const body = headingPrefix ? line.slice(headingPrefix.length) : line;
    const clauses = body.split(/([。；;])/);
    const filtered = clauses.map((clause) => FEMALE_ONLY_CLINICAL_CONTEXT.test(clause) ? "" : clause).join("").trim();
    return filtered ? `${headingPrefix}${filtered}` : "";
  }).filter((line) => line.trim()).join("\n");
}

/**
 * M03 can assess that an unreported symptom is “information不足”, but it must never promote
 * absence-of-data into “患者否认”. Keep this as a deterministic customer-output guard in
 * addition to the prompt contract because fabricated negative history can suppress follow-up.
 */
export function sanitizeUngroundedRedFlagNegations(content: string, state: CaseState): string {
  const source = trustedInputText(state);
  const jsonBlocks: string[] = [];
  const placeholderContent = content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      let sanitizedBlock = match;
      try {
        const visit = (value: unknown, key = ""): unknown => {
          // Identity labels are not patient assertions. They have already passed the stage contract;
          // running negation prose replacement over them can turn a valid diagnosis name into a
          // sentence such as "病历已记录头痛阳性" and break the signed result after validation.
          if (typeof value === "string" && key === "name") return value;
          if (typeof value === "string") return sanitizePatientApplicableText(sanitizeAgeClaimText(sanitizeUngroundedNegationText(value, source), state), state);
          if (Array.isArray(value)) return value.map((item) => visit(item, key));
          if (!value || typeof value !== "object") return value;
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([childKey, raw]) => [childKey, visit(raw, childKey)]),
          );
        };
        sanitizedBlock = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(visit(JSON.parse(jsonText)), null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        // Leave an invalid block unchanged; the structured-response validator will reject it.
      }
      const index = jsonBlocks.push(sanitizedBlock) - 1;
      return `\n__TCM_CDSS_JSON_BLOCK_${index}__\n`;
    },
  );
  const sanitizedNarrative = sanitizePatientApplicableText(sanitizeAgeClaimText(sanitizeUngroundedNegationText(placeholderContent, source), state), state);
  return sanitizedNarrative.replace(/__TCM_CDSS_JSON_BLOCK_(\d+)__/g, (_, index: string) => jsonBlocks[Number(index)] || "");
}

function structuredCaseText(state: CaseState): string {
  return trustedInputText(state);
}

// Full-width digits/letters/punctuation (１８０／１２０, ３９℃, ＳｐＯ２) from HIS exports or Chinese
// IMEs would silently fail every ASCII \d vitals parser and turn the safety gate fail-OPEN.
// Normalize to half-width before any numeric parse. Chinese clause punctuation (。；，) is left
// untouched so downstream negation/clause logic keeps working.
export function normalizeClinicalText(value: string): string {
  if (!value) return value;
  return value
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, " ")
    .replace(/．/g, ".")
    .replace(/／/g, "/")
    .replace(/％/g, "%");
}

const CONTEXTUAL_BLOOD_PRESSURE_SOURCE = String.raw`(?:(?:BP|bloodPressure|血压)["']?\s*[:：]?\s*["']?\s*|(?:本次|当前|现在|今日|今天)?\s*(?:复测|复查|再测)[^。；;\n\d]{0,8})(\d{2,3})\s*(?:\/|\\|-|－|—|–|~|～)\s*(\d{2,3})\s*(?:mmHg)?`;
const LABELED_BLOOD_PRESSURE_SOURCE = String.raw`(?:收缩压|高压)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:mmHg)?[^。；;\n]{0,16}(?:舒张压|低压)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:mmHg)?`;
const REVERSED_LABELED_BLOOD_PRESSURE_SOURCE = String.raw`(?:舒张压|低压)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:mmHg)?[^。；;\n]{0,16}(?:收缩压|高压)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:mmHg)?`;

type BloodPressureMeasurement = {
  systolic: number;
  diastolic: number;
  index: number;
  first?: number;
  second?: number;
};

const STRUCTURED_SYSTOLIC_BP_KEYS = [
  "systolicBP", "systolicBp", "SBP", "sbp", "systolic", "systolicPressure",
] as const;
const STRUCTURED_DIASTOLIC_BP_KEYS = [
  "diastolicBP", "diastolicBp", "DBP", "dbp", "diastolic", "diastolicPressure",
] as const;

type StructuredBloodPressureAssessment =
  | { status: "absent" }
  | { status: "invalid"; reason: "incomplete" | "format" | "range" | "order" }
  | { status: "valid"; value: { systolic: number; diastolic: number } };

function firstStructuredVitalValue(vitals: Record<string, unknown> | undefined, keys: readonly string[]): { present: boolean; value?: unknown } {
  if (!vitals) return { present: false };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(vitals, key)) return { present: true, value: vitals[key] };
  }
  return { present: false };
}

function structuredBloodPressureNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = normalizeClinicalText(value).trim().match(/^(\d{1,3})\s*(?:mmHg)?$/i);
  return match ? Number(match[1]) : null;
}

function structuredBloodPressureAssessment(state: CaseState): StructuredBloodPressureAssessment {
  const systolicEntry = firstStructuredVitalValue(state.vitals, STRUCTURED_SYSTOLIC_BP_KEYS);
  const diastolicEntry = firstStructuredVitalValue(state.vitals, STRUCTURED_DIASTOLIC_BP_KEYS);
  if (!systolicEntry.present && !diastolicEntry.present) return { status: "absent" };
  if (!systolicEntry.present || !diastolicEntry.present) return { status: "invalid", reason: "incomplete" };

  const systolic = structuredBloodPressureNumber(systolicEntry.value);
  const diastolic = structuredBloodPressureNumber(diastolicEntry.value);
  if (systolic == null || diastolic == null) return { status: "invalid", reason: "format" };
  if (systolic < 40 || systolic > 300 || diastolic < 20 || diastolic > 200) {
    return { status: "invalid", reason: "range" };
  }
  if (systolic <= diastolic) return { status: "invalid", reason: "order" };
  return { status: "valid", value: { systolic, diastolic } };
}

function contextualBloodPressurePattern(): RegExp {
  return new RegExp(CONTEXTUAL_BLOOD_PRESSURE_SOURCE, "gi");
}

function bloodPressureMeasurements(text: string): BloodPressureMeasurement[] {
  const normalized = normalizeClinicalText(text);
  const measurements: BloodPressureMeasurement[] = [];
  for (const match of normalized.matchAll(contextualBloodPressurePattern())) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (!Number.isFinite(first) || !Number.isFinite(second)) continue;
    const index = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    measurements.push({ systolic: first, diastolic: second, first, second, index });
  }
  for (const match of normalized.matchAll(new RegExp(LABELED_BLOOD_PRESSURE_SOURCE, "gi"))) {
    const index = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    measurements.push({ systolic: Number(match[1]), diastolic: Number(match[2]), index });
  }
  for (const match of normalized.matchAll(new RegExp(REVERSED_LABELED_BLOOD_PRESSURE_SOURCE, "gi"))) {
    const index = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    measurements.push({ systolic: Number(match[2]), diastolic: Number(match[1]), index });
  }
  return measurements.sort((a, b) => a.index - b.index);
}

function parseBloodPressure(text: string): { systolic: number; diastolic: number } | null {
  const measurement = bloodPressureMeasurements(text).find((item) => item.systolic > item.diastolic);
  return measurement ? { systolic: measurement.systolic, diastolic: measurement.diastolic } : null;
}

function hasInvalidBloodPressureOrder(text: string): boolean {
  return bloodPressureMeasurements(text).some((item) => item.systolic <= item.diastolic);
}

function criticalInvertedBloodPressure(text: string): { first: number; second: number } | null {
  const normalized = normalizeClinicalText(text);
  for (const measurement of bloodPressureMeasurements(normalized)) {
    if (measurement.first == null || measurement.second == null) continue;
    const { first, second } = measurement;
    if (!Number.isFinite(first) || !Number.isFinite(second) || first > second) continue;
    if (isExcludedClinicalAssertionAt(normalized, measurement.index) || isHistoricalOrResolvedAt(normalized, measurement.index)) continue;
    // Only an extreme value is eligible for the deterministic emergency fast path. Severe but
    // non-extreme hypertension requires repeat measurement plus symptom/target-organ assessment;
    // that contextual triage belongs to the semantic layer.
    if (Math.max(first, second) >= 220 || Math.min(first, second) >= 130 || Math.min(first, second) <= 45) {
      return { first, second };
    }
  }
  return null;
}

function bloodPressureIsCritical(bp: { systolic: number; diastolic: number } | null): boolean {
  return Boolean(bp && (bp.systolic >= 220 || bp.diastolic >= 130 || bp.systolic <= 80 || bp.diastolic <= 45));
}

// Accepts "38.9℃", "38.9度", the Chinese decimal idiom "38度9" (=38.9), and full-width input.
function parseTemperature(text: string): number | null {
  const t = normalizeClinicalText(text);
  // "38度9" / "38度9分" → 38.9 (度 as a decimal separator, 分 = tenth-of-a-degree). But a trailing digit
  // that begins a duration/count word ("39度2小时后复测", "38度9天") is NOT a decimal, so exclude those
  // units to avoid fabricating a temperature that could trip a red flag.
  const decimalDu = t.match(/(?<!\d)(4[0-5]|3\d)度(\d)(?!\d)(?!\s*(?:天|次|日|周|月|年|岁|小时|分钟|秒|时|点|余|多|回|下|个|号))/);
  if (decimalDu) return Number(`${decimalDu[1]}.${decimalDu[2]}`);
  const labeled = t.match(/(?:^|[^A-Za-z])(?:T|体温)["']?\s*[:：]?\s*["']?\s*(4[0-5]|3\d)(?:[.](\d))?/i);
  if (labeled) return Number(labeled[2] ? `${labeled[1]}.${labeled[2]}` : labeled[1]);
  const standalone = t.match(/(?<!\d)(4[0-5]|3\d)(?:[.](\d))?\s*(?:℃|°C|度)/i);
  if (standalone) return Number(standalone[2] ? `${standalone[1]}.${standalone[2]}` : standalone[1]);
  return null;
}

function parsePulse(text: string): number | null {
  const match = normalizeClinicalText(text).match(/(?:^|[^A-Za-z])(?:P|HR|心率|脉搏)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:次\/分|次每分|bpm)?/i);
  if (!match) return null;
  const value = Number(match[1]);
  // 生理可达边界之外的录入值（如 0、300 次/分）不是有效测量，交给非法值复核流程而不是危急值。
  return Number.isFinite(value) && value >= 20 && value <= 250 ? value : null;
}

function parseRespiration(text: string): number | null {
  const match = normalizeClinicalText(text).match(/(?:^|[^A-Za-z])(?:R|RR|呼吸)["']?\s*[:：]?\s*["']?\s*(\d{1,2})\s*(?:次\/分|次每分)?/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 5 && value <= 60 ? value : null;
}

function parseSpo2(text: string): number | null {
  const match = normalizeClinicalText(text).match(/(?:SpO2|指脉氧|血氧(?:饱和度)?|氧饱和度)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*%?/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 50 && value <= 100 ? value : null;
}

// 生理可达边界（与解析器一致）：超出边界或无法解析的录入值既不是“正常”，也不是有效危急值，
// 必须显式进入 missingItems 要求按范围/格式重录；真正的异常有效值仍按原阈值产生危急红旗。
function invalidSpo2Values(text: string): string[] {
  const normalized = normalizeClinicalText(text);
  const out: string[] = [];
  const pattern = /(?:(?:SpO2|指脉氧|血氧(?:饱和度)?|氧饱和度)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*%?|(?:本次|当前|现在|今日|今天)?\s*(?:复测|复查|再测)[^。；;\n\d]{0,8}(\d+(?:\.\d+)?)\s*%)/gi;
  for (const match of normalized.matchAll(pattern)) {
    const raw = match[1] || match[2];
    const value = Number(raw);
    const valueIndex = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(raw));
    if (isExcludedClinicalAssertionAt(normalized, valueIndex)) continue;
    if (!Number.isFinite(value) || value < 50 || value > 100) out.push(`${raw}%`);
  }
  return out;
}

function invalidPulseValues(text: string): string[] {
  const normalized = normalizeClinicalText(text);
  const out: string[] = [];
  for (const match of normalized.matchAll(/(?:^|[^A-Za-z])(?:P|HR|心率|脉搏)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*(?:次\/分|次每分|bpm)?/gi)) {
    const value = Number(match[1]);
    const valueIndex = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    if (isExcludedClinicalAssertionAt(normalized, valueIndex)) continue;
    if (!Number.isFinite(value) || value < 20 || value > 250) out.push(match[1]);
  }
  return out;
}

function invalidRespirationValues(text: string): string[] {
  const normalized = normalizeClinicalText(text);
  const out: string[] = [];
  for (const match of normalized.matchAll(/(?:^|[^A-Za-z])(?:R|RR|呼吸)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*(?:次\/分|次每分)?/gi)) {
    const value = Number(match[1]);
    const valueIndex = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    if (isExcludedClinicalAssertionAt(normalized, valueIndex)) continue;
    if (!Number.isFinite(value) || value < 5 || value > 60) out.push(match[1]);
  }
  return out;
}

function invalidTemperatureValues(text: string): string[] {
  const normalized = normalizeClinicalText(text);
  const out: string[] = [];
  // 仅带 T/体温 标签的候选：无标签的 ℃ 数值（水温等）不按体温非法值处理。
  for (const match of normalized.matchAll(/(?:^|[^A-Za-z])(?:T|体温)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*(?:℃|°C|度)?/gi)) {
    const value = Number(match[1]);
    const valueIndex = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    if (isExcludedClinicalAssertionAt(normalized, valueIndex)) continue;
    if (!Number.isFinite(value) || value < 30 || value > 45) out.push(match[1]);
  }
  // 中文小数写法“45度9”=45.9：先按整数位通过上一条扫描，这里按真实小数值复核。
  for (const match of normalized.matchAll(/(?:^|[^A-Za-z])(?:T|体温)["']?\s*[:：]?\s*["']?\s*(\d{2})度(\d)/g)) {
    const value = Number(`${match[1]}.${match[2]}`);
    const valueIndex = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    if (isExcludedClinicalAssertionAt(normalized, valueIndex)) continue;
    if (value < 30 || value > 45) out.push(String(value));
  }
  return out;
}

function preferAbnormalNumber(
  primary: number | null,
  secondary: number | null,
  isAbnormal: (value: number) => boolean,
): number | null {
  if (secondary != null && isAbnormal(secondary)) return secondary;
  return primary ?? secondary;
}

function isHistoricalOrResolvedAt(text: string, index: number, eventLength = 0): boolean {
  return clinicalEventTemporalScopeAt(text, index, eventLength) !== "current";
}

function parseContextualNumber(
  text: string,
  pattern: RegExp,
  toNumber: (match: RegExpMatchArray) => number | null,
  isAbnormal: (value: number) => boolean,
): number | null {
  const normalized = normalizeClinicalText(text);
  let fallback: number | null = null;
  for (const match of normalized.matchAll(pattern)) {
    const value = toNumber(match);
    if (value == null || !Number.isFinite(value)) continue;
    const numericCapture = match.slice(1).find((part) => part && /\d/.test(part));
    const valueOffset = numericCapture ? match[0].lastIndexOf(numericCapture) : 0;
    const index = (match.index ?? 0) + Math.max(0, valueOffset);
    if (isExcludedClinicalAssertionAt(normalized, index)) continue;
    if (isHistoricalOrResolvedAt(normalized, index, match[0].length - Math.max(0, valueOffset))) continue;
    if (fallback == null) fallback = value;
    if (isAbnormal(value)) return value;
  }
  return fallback;
}

function parseContextualTemperature(text: string): number | null {
  return parseContextualNumber(
    text,
    /(?:(?:^|[^A-Za-z])(?:T|体温)["']?\s*[:：]?\s*["']?\s*)?(4[0-5]|3\d)(?:(?:[.](\d))|(?:度(\d)))?\s*(?:℃|°C|度)?/gi,
    (match) => {
      if (!/(?:T|体温|℃|°C|度)/i.test(match[0])) return null;
      const decimal = match[2] || match[3];
      return Number(decimal ? `${match[1]}.${decimal}` : match[1]);
    },
    (value) => value >= 39 || value < 36,
  );
}

function parseContextualPulse(text: string): number | null {
  return parseContextualNumber(
    text,
    /(?:^|[^A-Za-z])(?:P|HR|心率|脉搏)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:次\/分|次每分|bpm)?/gi,
    (match) => {
      const value = Number(match[1]);
      return Number.isFinite(value) && value >= 20 && value <= 250 ? value : null;
    },
    (value) => value >= 120 || value < 50,
  );
}

function parseContextualRespiration(text: string): number | null {
  return parseContextualNumber(
    text,
    /(?:^|[^A-Za-z])(?:R|RR|呼吸)["']?\s*[:：]?\s*["']?\s*(\d{1,2})\s*(?:次\/分|次每分)?/gi,
    (match) => {
      const value = Number(match[1]);
      return Number.isFinite(value) && value >= 5 && value <= 60 ? value : null;
    },
    (value) => value >= 25 || value < 8,
  );
}

function parseContextualSpo2(text: string): number | null {
  return parseContextualNumber(
    text,
    /(?:(?:SpO2|指脉氧|血氧(?:饱和度)?|氧饱和度)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*%?|(?:本次|当前|现在|今日|今天)?\s*(?:复测|复查|再测)[^。；;\n\d]{0,8}(\d+(?:\.\d+)?)\s*%)/gi,
    (match) => {
      const value = Number(match[1] || match[2]);
      return Number.isFinite(value) && value >= 50 && value <= 100 ? value : null;
    },
    (value) => value <= 91,
  );
}

function parseContextualBloodPressure(text: string): { systolic: number; diastolic: number } | null {
  const normalized = normalizeClinicalText(text);
  let fallback: { systolic: number; diastolic: number } | null = null;
  for (const measurement of bloodPressureMeasurements(normalized)) {
    const { systolic, diastolic } = measurement;
    if (!Number.isFinite(systolic) || !Number.isFinite(diastolic) || systolic <= diastolic) continue;
    if (isExcludedClinicalAssertionAt(normalized, measurement.index) || isHistoricalOrResolvedAt(normalized, measurement.index)) continue;
    const bp = { systolic, diastolic };
    if (!fallback) fallback = bp;
    if (bloodPressureIsCritical(bp)) return bp;
  }
  return fallback;
}

export function currentVitalsSummary(state: CaseState): string | undefined {
  const topLevel = state.vitals || {};
  const observations = (field: keyof HisRecordSnapshot["fields"], label: string, keys: string[]) => {
    const authoritative = fieldText(state, field);
    const values = (isKnownClinicalText(authoritative)
      ? [authoritative]
      : keys.map((key) => stringifyClinicalValue(topLevel[key])))
      .filter((value) => isKnownClinicalText(value));
    return values.map((value) => `${label}:${value}`).join("；");
  };
  const authoritativeBloodPressure = fieldText(state, "vitalsBP");
  const splitBloodPressure = !isKnownClinicalText(authoritativeBloodPressure)
    ? structuredBloodPressureAssessment(state)
    : { status: "absent" as const };
  const structuredVitals = [
    observations("vitalsT", "T", ["temperature", "T", "temp"]),
    observations("vitalsP", "P", ["pulse", "P", "heartRate", "HR"]),
    observations("vitalsR", "R", ["respiration", "R", "respiratoryRate", "RR"]),
    observations("vitalsBP", "BP", ["bloodPressure", "BP", "bp"]),
    splitBloodPressure.status === "valid" ? `BP:${splitBloodPressure.value.systolic}/${splitBloodPressure.value.diastolic}` : "",
  ].filter(Boolean).join("；");
  const temperature = parseContextualTemperature(structuredVitals);
  const pulse = parseContextualPulse(structuredVitals);
  const respiration = parseContextualRespiration(structuredVitals);
  const bloodPressure = parseContextualBloodPressure(structuredVitals);
  const authoritativeDetail = fieldText(state, "vitalsDetail");
  const detail = isKnownClinicalText(authoritativeDetail)
    ? authoritativeDetail
    : [
        stringifyClinicalValue(topLevel.detail),
        ...[topLevel.SpO2, topLevel.spo2, topLevel.oxygenSaturation]
          .map((value) => stringifyClinicalValue(value))
          .filter((value) => isKnownClinicalText(value))
          .map((value) => `SpO2:${value}`),
      ].filter((value) => isKnownClinicalText(value)).join("；");
  const spo2 = preferAbnormalNumber(parseContextualSpo2(detail), parseContextualSpo2(structuredVitals), (value) => value <= 91);
  const parts = [
    temperature != null ? `T ${temperature}℃` : "",
    pulse != null ? `P ${pulse}次/分` : "",
    respiration != null ? `R ${respiration}次/分` : "",
    bloodPressure ? `BP ${bloodPressure.systolic}/${bloodPressure.diastolic}mmHg` : "",
    spo2 != null ? `SpO2 ${spo2}%` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("；") : undefined;
}

function vitalsText(state: CaseState): string {
  return [
    currentVitalsSummary(state),
    fieldText(state, "vitalsT") && `T:${fieldText(state, "vitalsT")}`,
    fieldText(state, "vitalsP") && `P:${fieldText(state, "vitalsP")}`,
    fieldText(state, "vitalsR") && `R:${fieldText(state, "vitalsR")}`,
    fieldText(state, "vitalsBP") && `BP:${fieldText(state, "vitalsBP")}`,
    fieldText(state, "vitalsDetail"),
  ].filter(Boolean).join(" ");
}

function hasRequiredVitals(state: CaseState): boolean {
  const text = vitalsText(state);
  return Boolean(parseTemperature(text) && parsePulse(text) && parseRespiration(text) && parseBloodPressure(text));
}

const VITAL_FIELD_CHECKS: Array<{ key: keyof HisRecordSnapshot["fields"]; vitalKeys: string[]; label: string; parse: (s: string) => unknown; name: string }> = [
    { key: "vitalsBP", vitalKeys: ["bloodPressure", "BP", "bp"], label: "BP", parse: parseBloodPressure, name: "血压" },
    { key: "vitalsT", vitalKeys: ["temperature", "T", "temp"], label: "T", parse: parseTemperature, name: "体温" },
    { key: "vitalsP", vitalKeys: ["pulse", "P", "heartRate", "HR"], label: "P", parse: parsePulse, name: "脉搏/心率" },
    { key: "vitalsR", vitalKeys: ["respiration", "R", "respiratoryRate", "RR"], label: "R", parse: parseRespiration, name: "呼吸" },
];

type InvalidVitalFinding = {
  name: "血压" | "体温" | "脉搏/心率" | "呼吸" | "血氧";
  label: string;
  value: string;
  kind: "range" | "format";
  expected: string;
};

const INVALID_VITAL_LABELS = {
  血压: "血压",
  体温: "体温",
  "脉搏/心率": "脉搏/心率",
  呼吸: "呼吸",
  血氧: "血氧饱和度（SpO2）",
} as const;

const INVALID_VITAL_EXPECTED = {
  血压: "收缩压/舒张压mmHg（收缩压40-300、舒张压20-200，如120/80）",
  体温: "30-45℃",
  "脉搏/心率": "20-250次/分",
  呼吸: "5-60次/分",
  血氧: "50-100%",
} as const;

// 已录入但非法（无法解析或超出生理可达边界）的生命体征：逐项给出原始值与所需格式/范围，
// 让医生明确重录要求。只报第一个 offending 值，避免同一项重复告警。
function invalidEnteredVitalFindings(state: CaseState): InvalidVitalFinding[] {
  const findings: InvalidVitalFinding[] = [];
  const push = (name: InvalidVitalFinding["name"], value: string, kind: InvalidVitalFinding["kind"]) => {
    if (findings.some((finding) => finding.name === name)) return;
    findings.push({
      name,
      label: INVALID_VITAL_LABELS[name],
      value: value.slice(0, 24),
      kind,
      expected: INVALID_VITAL_EXPECTED[name],
    });
  };
  const structuredBloodPressure = structuredBloodPressureAssessment(state);
  if (structuredBloodPressure.status === "invalid") {
    const rawSystolic = stringifyClinicalValue(firstStructuredVitalValue(state.vitals, STRUCTURED_SYSTOLIC_BP_KEYS).value) || "（缺）";
    const rawDiastolic = stringifyClinicalValue(firstStructuredVitalValue(state.vitals, STRUCTURED_DIASTOLIC_BP_KEYS).value) || "（缺）";
    push(
      "血压",
      `收缩压${rawSystolic}/舒张压${rawDiastolic}`,
      structuredBloodPressure.reason === "range" || structuredBloodPressure.reason === "order" ? "range" : "format",
    );
  }
  for (const check of VITAL_FIELD_CHECKS) {
    // A top-level value may have been entered through an API client even when an HIS snapshot is
    // also present. It is not trusted as an affirmative red-flag fact, but a malformed entered value
    // must still fail closed and request correction instead of silently disappearing.
    const enteredValues = [
      fieldText(state, check.key),
      ...check.vitalKeys.map((key) => stringifyClinicalValue(state.vitals?.[key])),
    ].filter((value) => isKnownClinicalText(value));
    for (const value of enteredValues) {
      if (check.parse(`${check.label}:${value}`) == null) {
        push(check.name as InvalidVitalFinding["name"], value, /\d/.test(value) ? "range" : "format");
        break;
      }
    }
  }
  const corpus = `${vitalsText(state)}\n${trustedInputText(state)}`;
  // 结构化录入的 SpO2（topLevel.SpO2/spo2/oxygenSaturation）不带标签地散落在 vitals 对象里，
  // 显式补上标签再扫，避免非法血氧经结构化通道静默消失。
  const structuredSpo2 = [state.vitals?.SpO2, state.vitals?.spo2, state.vitals?.oxygenSaturation]
    .map((value) => stringifyClinicalValue(value))
    .filter((value) => isKnownClinicalText(value))
    .map((value) => `SpO2:${value}`)
    .join("\n");
  const invalidSpo2 = invalidSpo2Values(`${corpus}\n${structuredSpo2}`);
  if (invalidSpo2.length > 0) push("血氧", invalidSpo2[0], "range");
  const invalidPulse = invalidPulseValues(corpus);
  if (invalidPulse.length > 0) push("脉搏/心率", invalidPulse[0], "range");
  const invalidRespiration = invalidRespirationValues(corpus);
  if (invalidRespiration.length > 0) push("呼吸", invalidRespiration[0], "range");
  const invalidTemperature = invalidTemperatureValues(corpus);
  if (invalidTemperature.length > 0) push("体温", invalidTemperature[0], "range");
  return findings;
}

function formatInvalidVitalFinding(finding: InvalidVitalFinding): string {
  return finding.kind === "range"
    ? `${finding.label}数值异常(${finding.value})，请按 ${finding.expected} 范围重新录入`
    : `${finding.label}无法识别为有效数值(${finding.value})，请按 ${finding.expected} 格式重新录入`;
}

function unparseableVitalNames(state: CaseState): string[] {
  return Array.from(new Set(invalidEnteredVitalFindings(state).map((finding) => finding.name)));
}

// Missing vital signs remain optional for an ordinary, non-high-risk presentation. Once a value is
// entered, however, an unparseable value must not silently unlock a dose-level prescription.
export function unparseableVitalAdvisories(state: CaseState): string[] {
  return unparseableVitalNames(state).map((name) => `${name}已录入但无法识别为有效数值，请核对录入格式（处方前必须复核）`);
}

function symptomsFieldText(state: CaseState, key: string): string {
  const value = state.symptoms?.[key];
  return stringifyClinicalValue(value);
}

export function deriveOperationalCompleteness(state: CaseState): Completeness {
  const chiefText = authoritativeFieldOrFallback(state, "zhushu", state.chiefComplaint);
  const presentHistoryText = authoritativeFieldOrFallback(state, "xianbingshi", symptomsFieldText(state, "presentHistory"));
  const hasChief = isKnownClinicalText(chiefText);
  const hasVitals = hasRequiredVitals(state);
  const hasTongue = isKnownTongueClinicalText(authoritativeFieldOrFallback(state, "tcmTongue", state.tongue)) ||
    Boolean(state.hisRecord?.tongueImageUploaded && isKnownTongueClinicalText(state.tongueImageDesc));
  const hasPulse = isKnownPulseClinicalText(authoritativeFieldOrFallback(state, "tcmPulse", state.pulse));
  const hasPresentHistory = isKnownClinicalText(presentHistoryText);
  const hasTcmDetail = isKnownClinicalText(authoritativeFieldOrFallback(state, "tcmDetail", symptomsFieldText(state, "tcmDetail"))) ||
    isKnownClinicalText(authoritativeFieldOrFallback(state, "tcmFace", state.faceNote));
  const hasPastOrMedicationContext = isKnownClinicalText(authoritativeFieldOrFallback(state, "jiwangshi", state.pastHistory)) ||
    isKnownClinicalText(authoritativeFieldOrFallback(state, "yongyaoshi", state.medicationHistory)) ||
    isKnownClinicalText(authoritativeFieldOrFallback(state, "guomin", state.allergyHistory));

  const compactNarrative = (value: string) => value.normalize("NFKC").replace(/[\s，,。.!！?？；;：:、（）()【】\[\]"'“”‘’_-]+/g, "");
  const compactChief = compactNarrative(chiefText);
  const compactHistory = compactNarrative(presentHistoryText);
  const novelHistory = compactChief && compactHistory.includes(compactChief)
    ? compactHistory.replace(compactChief, "")
    : compactHistory;
  const hasDistinctPresentHistory = hasPresentHistory && (
    !compactChief ||
    (compactHistory !== compactChief && !compactChief.includes(compactHistory) && novelHistory.length >= 6)
  );
  const hasNarrativeDetail = hasDistinctPresentHistory || hasTcmDetail;
  const hasContextDetail = hasNarrativeDetail || hasPastOrMedicationContext;
  const redFlagScreenText = trustedInputText(state);
  const hasExplicitRedFlagScreening = /(否认|无|不伴|未见|排除|已查|检查).{0,40}(胸痛|胸闷|气促|呼吸困难|晕厥|黑便|便血|呕血|肢体无力|剧烈头痛|高热|寒战|抽搐|意识障碍|自杀|轻生|自伤|他伤|心电图|血压|血氧|生命体征)|生命体征|T\s*\d|BP\s*\d|血压\s*\d|心率\s*\d|血氧\s*\d/i.test(redFlagScreenText);
  const redFlag = Math.min(1,
    (hasChief ? 0.28 : 0) +
    (hasContextDetail ? 0.22 : 0) +
    (hasExplicitRedFlagScreening ? 0.25 : 0) +
    (hasVitals ? 0.25 : 0),
  );
  const rawInfoGain = [hasChief, hasNarrativeDetail, hasTongue, hasPulse].filter(Boolean).length / 4;
  const infoGain = hasNarrativeDetail ? rawInfoGain : Math.min(rawInfoGain, 0.5);
  const managementImpact = [
    hasChief,
    hasTongue,
    hasPulse,
    hasContextDetail || hasVitals || hasPastOrMedicationContext,
  ].filter(Boolean).length / 4;
  const rawAnswerability = [hasChief, hasTongue, hasPulse, hasNarrativeDetail].filter(Boolean).length / 4;
  const answerability = hasNarrativeDetail ? rawAnswerability : Math.min(rawAnswerability, 0.5);
  const scores = { redFlag, infoGain, managementImpact, answerability };
  return {
    ...scores,
    level: determineCompletenessLevel(scores),
  };
}

/** M03 uses the chief complaint as its only required clinical entry point. */
export function canProceedToM03AfterFollowup(state: CaseState): boolean {
  return isKnownClinicalText(state.chiefComplaint || fieldText(state, "zhushu"));
}

// 裸“没”是口语标准否定词（“没胸痛晕倒”），但大量固定搭配里它不是对后续症状词的否定
// （没胃口=纳差、没精神=乏力、没什么/没关系/没问题…），用负向前瞻排除这些搭配，避免制造漏报。
const NEGATION_PATTERN = new RegExp(`(否认|不是(?!${DEGREE_AFTER_NEGATOR})|并非(?!${DEGREE_AFTER_NEGATOR})|不曾|无|未见|没有|没(?!有什么|关系|问题|事|错|完|意思|办法|时间|空|钱|人|影|底|数|辙|门|胃口|精神|力气|劲儿|劲|趣)|未诉|无诉|未主诉|未出现|未发生|未有|未曾|未再发|无再发|从未|从无|没有过|不伴|已缓解|已消失|排除)`, "g");
const NON_NEGATING_PHRASES = /(无明显诱因|无诱因|无缓解|无好转|无改善|没缓解|没好转|没改善|没消失|无规律|无特殊处理|未予处理|未治疗)/g;

function containsNegation(value: string): boolean {
  NEGATION_PATTERN.lastIndex = 0;
  const result = NEGATION_PATTERN.test(value);
  NEGATION_PATTERN.lastIndex = 0;
  return result;
}

type ClinicalAssertionSubject = "patient" | "non_patient";
type ClinicalAssertionMood = "actual" | "conditional";
type ClinicalAssertionTemporality = "current" | "historical";

type ClinicalAssertionContext = {
  subject: ClinicalAssertionSubject;
  mood: ClinicalAssertionMood;
  temporality: ClinicalAssertionTemporality;
};

const PATIENT_SUBJECT_MARKER = /^(?:患者本人|患者|病人|患儿|本人|我)$/;
const CLINICAL_SUBJECT_MARKERS = /(?:我|其)?(?:父亲|母亲|爸爸|妈妈|爸|妈|父母|家属|家人|家里人|亲属|祖父|祖母|爷爷|奶奶|外祖父|外祖母|姥爷|姥姥|儿子|女儿|哥哥|姐姐|弟弟|妹妹|兄|姐|弟|妹|兄弟|姐妹|丈夫|妻子|配偶|岳父|岳母|岳父母|公公|婆婆|公婆|伯父|伯母|叔叔|婶婶|舅舅|舅妈|姑姑|姑父|姨妈|姨父|侄子|侄女|外甥|外甥女)|患者本人|患者|病人|患儿|本人|我/g;

function clinicalAssertionContextAt(text: string, index: number): ClinicalAssertionContext {
  const normalized = normalizeClinicalText(text);
  const hardStart = Math.max(
    normalized.lastIndexOf("。", index - 1),
    normalized.lastIndexOf("；", index - 1),
    normalized.lastIndexOf(";", index - 1),
    normalized.lastIndexOf("\n", index - 1),
  ) + 1;
  const prefix = normalized.slice(hardStart, index);

  const conditionalMatches = [...prefix.matchAll(/(?:若|如果|一旦|倘若|假如|当(?=(?:患者|病人|患儿|本人|我|出现|发生|血压|血氧|体温|心率|脉搏|呼吸))|如(?:出现|发生|再发|有)?(?=$))(?=[^。；;\n]{0,40})/g)];
  const lastConditional = conditionalMatches.at(-1);
  let mood: ClinicalAssertionMood = "actual";
  if (lastConditional?.index != null) {
    const afterConditional = prefix.slice(lastConditional.index + lastConditional[0].length);
    const resetMatch = [...afterConditional.matchAll(/(?:(?:但|但是|然而|实际(?:上)?|事实上)[^。；;\n]{0,16}|[，,]\s*)(?:患者本人|患者|病人|患儿|本人|我)\s*/g)].at(-1);
    const resetTail = resetMatch?.index == null
      ? ""
      : afterConditional.slice(resetMatch.index + resetMatch[0].length);
    const lastComma = Math.max(afterConditional.lastIndexOf("，"), afterConditional.lastIndexOf(","));
    const assertionClauseEndCandidates = ["，", ",", "。", "；", ";", "\n"]
      .map((marker) => normalized.indexOf(marker, index))
      .filter((value) => value >= 0);
    const assertionClauseEnd = assertionClauseEndCandidates.length > 0
      ? Math.min(...assertionClauseEndCandidates)
      : normalized.length;
    const assertionClause = normalized.slice(index, assertionClauseEnd);
    const commaDelimitedClause = lastComma >= 0
      ? `${afterConditional.slice(lastComma + 1)}${assertionClause}`
      : "";
    const explicitCurrentReset = /(?:(?:但|但是|然而|实际(?:上)?|事实上)[^。；;\n]{0,16}|[，,]\s*)(?:患者本人|患者|病人|患儿|本人|我)?\s*(?:本次|目前|当前|现在|今日|今天|今晨|现(?:已|在)?|确有|已出现|已经|正在|仍(?:在|有)?|刚刚|突然|突发)/.test(afterConditional)
      || Boolean(commaDelimitedClause) && /(?:本次|目前|当前|现在|今日|今天|今晨|现(?:已|在)?|确有|已出现|已经|正在|仍(?:在|有)?|刚刚|突然|突发|持续\s*\d)/.test(commaDelimitedClause);
    const modalOrFutureTail = /(?:会|将|可能|也许|或许|预计|计划|打算|拟|假如|若|如果|一旦|时则|时会|就会)/.test(`${resetTail} ${commaDelimitedClause}`);
    const independentPatientReset = Boolean(resetMatch) && !modalOrFutureTail;
    const resetToCurrentPatient = explicitCurrentReset && !modalOrFutureTail || independentPatientReset;
    if (!resetToCurrentPatient) mood = "conditional";
  }
  const assertionEndCandidates = ["。", "；", ";", "\n"]
    .map((marker) => normalized.indexOf(marker, index))
    .filter((value) => value >= 0);
  const assertionEnd = assertionEndCandidates.length > 0 ? Math.min(...assertionEndCandidates) : normalized.length;
  const assertionTail = normalized.slice(index, assertionEnd);
  if (/^[^，,。；;\n]{0,28}时\s*(?:应|需|要|则|会|可|请|立即|建议)/.test(assertionTail)) {
    mood = "conditional";
  }

  let subject: ClinicalAssertionSubject = /家族史\s*[:：]?/.test(prefix) ? "non_patient" : "patient";
  const clauseStart = Math.max(
    hardStart,
    normalized.lastIndexOf("，", index - 1) + 1,
    normalized.lastIndexOf(",", index - 1) + 1,
  );
  const clauseEndCandidates = ["，", ",", "。", "；", ";", "\n"]
    .map((marker) => normalized.indexOf(marker, index))
    .filter((value) => value >= 0);
  const clauseEnd = clauseEndCandidates.length > 0 ? Math.min(...clauseEndCandidates) : normalized.length;
  const clause = normalized.slice(clauseStart, clauseEnd);
  const assertionOffset = index - clauseStart;
  let nearestDistance = Number.POSITIVE_INFINITY;
  CLINICAL_SUBJECT_MARKERS.lastIndex = 0;
  for (const match of clause.matchAll(CLINICAL_SUBJECT_MARKERS)) {
    const markerStart = match.index ?? 0;
    const markerEnd = markerStart + match[0].length;
    const distance = markerEnd <= assertionOffset
      ? assertionOffset - markerEnd
      : markerStart >= assertionOffset
        ? markerStart - assertionOffset
        : 0;
    if (distance <= nearestDistance) {
      nearestDistance = distance;
      subject = PATIENT_SUBJECT_MARKER.test(match[0]) ? "patient" : "non_patient";
    }
  }
  CLINICAL_SUBJECT_MARKERS.lastIndex = 0;
  const reporterPrefix = normalized.slice(hardStart, index);
  if (
    /(?:家属|家人|亲属)\s*(?:代诉|诉|称|反映|报告|告知|提供病史)\s*[：:]?[^。；;\n]*$/.test(reporterPrefix) &&
    !/(?:家属|家人|亲属)(?:本人|自己)|(?:家属|家人|亲属)\s*(?:有|出现|发生|突发|患有)/.test(reporterPrefix)
  ) {
    subject = "patient";
  }

  const temporalScope = clinicalEventTemporalScopeAt(normalized, index);
  const temporality: ClinicalAssertionTemporality = temporalScope === "current" ? "current" : "historical";

  return { subject, mood, temporality };
}

function isExcludedClinicalAssertionAt(text: string, index: number): boolean {
  const context = clinicalAssertionContextAt(text, index);
  return context.subject === "non_patient" || context.mood === "conditional";
}

function hasPatientScopedSpanOccurrence(text: string, span: string): boolean {
  let offset = text.indexOf(span);
  while (offset >= 0) {
    const assertionIndex = offset + Math.max(0, span.length - 1);
    if (!isExcludedClinicalAssertionAt(text, assertionIndex)) return true;
    offset = text.indexOf(span, offset + span.length);
  }
  return false;
}

function isNegatedAt(text: string, index: number): boolean {
  const hardStart = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const before = text.slice(Math.max(hardStart, index - 40), index).replace(NON_NEGATING_PHRASES, "");
  const matches = Array.from(before.matchAll(NEGATION_PATTERN));
  if (matches.length === 0) return false;

  const last = matches[matches.length - 1];
  const lastNegationEnd = (last.index ?? 0) + last[0].length;
  if (last[0] === "排除") {
    const beforeNegation = before.slice(Math.max(0, (last.index ?? 0) - 8), last.index ?? 0);
    if (/(无法|不能|不可|尚未|未能|难以|需|待|仍需)/.test(beforeNegation)) return false;
  }
  const afterNegation = before.slice(lastNegationEnd);
  if (/(但|但是|然而|不过|却|但有|另有|仍有|转为|改为)/.test(afterNegation) ||
      /[，,](?:昨|今|近(?:日|天|两|几|\d)|本次|此次|当前|目前|现在|活动后|运动后|劳累后|持续|新发|突发|突然|出现|伴有|继而|随后|开始)/.test(afterNegation)) {
    return false;
  }
  const commaIndex = Math.max(afterNegation.lastIndexOf("，"), afterNegation.lastIndexOf(","));
  if (commaIndex >= 0) {
    const afterComma = afterNegation.slice(commaIndex + 1);
    const beforeComma = afterNegation.slice(0, commaIndex);
    const explicitNegativeContinuation = new RegExp(`^(?:也|亦|并|且|均|都)?\\s*(?:否认|不是(?!${DEGREE_AFTER_NEGATOR})|并非(?!${DEGREE_AFTER_NEGATOR})|不曾|无|未见|没有|未诉|未出现|未发生|不伴)`).test(afterComma.trim());
    const explicitPositiveClause = /^(?:突发|出现|再发|复发|伴|伴有|持续|加重|发作|本次|当前|目前|现在|现|诉|呈|排出|排)/.test(afterComma.trim());
    // Ordinary commas may continue a compact denial list ("否认胸痛，胸闷，气促"). A prior
    // enumeration comma, however, closes that list before the comma ("否认胸痛、气促，晕厥").
    // Concrete actions/counts are handled as positive evidence by hasCommaSeparatedPositiveEvidence.
    if (!explicitNegativeContinuation && (beforeComma.includes("、") || explicitPositiveClause)) return false;
  }
  const enumerationIndex = afterNegation.lastIndexOf("、");
  if (enumerationIndex >= 0) {
    const afterEnumeration = afterNegation.slice(enumerationIndex + 1).trim();
    if (/^(?:但|但有|却|另有|出现|发生|伴|伴有|合并|继而|随后|再发|复发|新发|突发|突然|持续|加重)/.test(afterEnumeration)) return false;
  }

  return before.length - lastNegationEnd <= 42;
}

function hasCommaSeparatedPositiveEvidence(text: string, index: number, term: string): boolean {
  const hardClauseStart = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const beforeTerm = text.slice(hardClauseStart, index);
  const lastComma = Math.max(beforeTerm.lastIndexOf("，"), beforeTerm.lastIndexOf(","), beforeTerm.lastIndexOf("、"));
  if (lastComma < 0) return false;
  const beforeComma = beforeTerm.slice(0, lastComma);
  const afterComma = beforeTerm.slice(lastComma + 1);
  const after = text.slice(index + term.length, index + term.length + 44);
  if (!containsNegation(beforeComma) || containsNegation(afterComma)) return false;
  const separator = beforeTerm[lastComma];
  if (separator === "、" && !/^(?:但|但有|却|另有|出现|发生|伴|伴有|合并|继而|随后|再发|复发|新发|突发|突然|持续|加重)/.test(afterComma.trim())) {
    return false;
  }
  if (/^(?:(?:一|二|两|三|四|五|六|七|八|九|十|数|多|几)?次\s*)?(?:也|均|都)?\s*(?:并|且)?\s*(?:未|没有|无|未见|未出现|未发生|并未|且未|也未|也没有)/.test(after)) return false;
  return /(?:突发|剧烈|急性|持续|加重|快速加重)/.test(term) ||
    /(?:伴有?|合并|继而|随后)[^，,。；;\n]+/.test(term) ||
    /^(?:排出?|出现|发生|伴|伴有|合并|再发|复发|突发|突然|新发|今(?:日|晨)|昨(?:日|晚|夜)|持续|加重)/.test(afterComma.trim()) ||
    /(?:伴有?|并|且|继而|随后)[^，,。；;\n]*$/.test(afterComma.trim()) ||
    /^(?:约|已|持续|反复)?\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半数多几]+)\s*(?:次|分钟|分|小时|天|日|周|月|ml|mL|毫升)/.test(after) ||
    /^(?:后|伴有?|并|且|持续|反复|加重|发作|导致|致|继而|随后)/.test(after);
}

function hasTerm(text: string, term: string): boolean {
  let index = text.indexOf(term);
  while (index !== -1) {
    if (isExcludedClinicalAssertionAt(text, index)) {
      index = text.indexOf(term, index + term.length);
      continue;
    }
    const after = text.slice(index + term.length, index + term.length + 44);
    const postPersistentCue = /^(?:、|，|,|及|和|与|或)?[^。；;\n]{0,18}(?:没有|无|未见|未|尚未|并未).{0,8}(?:缓解|好转|改善)/.test(after);
    // 只有“均/皆/都”这类量化词才合法地回指前面的症状列表（“黑便、呕血、便血均无”），才允许较宽间隔。
    const postCollectiveNegated = /^(?:、|，|,|及|和|与|或)?[^。；;\n]{0,18}(?:均无|均未见|均否认|皆无|皆未见|皆否认|都无|都未见|都没有)/.test(after);
    // 顿号并列清单后接裸否定（“黑便、呕血、便血无”）：仅当间隔全为顿号并列项、不含逗号/数字时才算集合否定。
    const postListNegated = /^、[^。；;，,\d\n]{0,16}(?:无|未见|没有|否认|阴性)/.test(after);
    // 裸“无/否认/未见/已缓解”只有紧贴症状词时才是对它本身的否定（“黑便无”“黑便：否认”“黑便已缓解”）。
    // fail-closed 关键修复：不得跨过逗号/数字进入下一分句——“黑便3天，无腹痛”里的“无”否定的是腹痛，
    // 绝不能因此把作为红旗的“黑便”判为阴性而漏报消化道出血（其余晕厥/便血/呕血/肢体无力/寒战同理）。
    const postDirectNegated = /^[：:（(【\[\s]{0,4}(?:无|未见|没有|否认|阴性|未再发|无再发|已缓解|已消失)/.test(after);
    const postExplicitNegated = /^(?:(?:一|二|两|三|四|五|六|七|八|九|十|数|多|几)?次\s*)?(?:也|均|都)?\s*(?:并|且)?\s*(?:未|没有|无|未见|未出现|未发生|并未|且未|也未|也没有)(?:出现|发生|发作|再发|过)?/.test(after);
    const postNegated = !postPersistentCue && (postCollectiveNegated || postListNegated || postDirectNegated || postExplicitNegated);
    const historicalResolved = isHistoricalOrResolvedAt(text, index, term.length);
    const anaphoricRecurrence = hasAnaphoricRecurrenceAfter(text, index, term);
    // A comma normally continues an explicit negative symptom list. It becomes a positive boundary
    // only when the new entity carries its own action cue ("排黑色便") or a concrete duration/count
    // ("呕血1次", "便血2日"). This preserves sensitivity without turning routine comma-separated
    // denials into a wall of false red flags.
    const commaSeparatedTimedPositive = hasCommaSeparatedPositiveEvidence(text, index, term);
    if (((!isNegatedAt(text, index) || commaSeparatedTimedPositive) && !postNegated && !historicalResolved) || anaphoricRecurrence) return true;
    index = text.indexOf(term, index + term.length);
  }
  return false;
}

function hasAnaphoricRecurrenceAfter(text: string, index: number, term: string): boolean {
  const before = text.slice(Math.max(0, index - 18), index);
  const after = text.slice(index + term.length, index + term.length + 80);
  if (!/(既往|曾经|曾有|曾|此前|过去|上次)/.test(before)) return false;
  return /(?:已缓解|已消失|已好转|治疗后好转|无再发|未再发)[^。；;\n]{0,24}[、，,；;]?\s*(?:本次|当前|目前|现在|今日|今天)?\s*(?:再次|再度|又)?(?:再发|复发|发作|出现)(?![^。；;\n]{0,8}(?:未|无|否认))/.test(after);
}

type ClinicalAssertionSpan = {
  start: number;
  end: number;
  text: string;
};

function clinicalAssertionSpanAt(text: string, index: number): ClinicalAssertionSpan {
  const start = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const endCandidates = ["。", "；", ";", "\n"]
    .map((mark) => text.indexOf(mark, index))
    .filter((position) => position >= 0);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : text.length;
  return { start, end, text: text.slice(start, end) };
}

function hasAffirmedPatternInSpan(text: string, span: ClinicalAssertionSpan, pattern: RegExp): boolean {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  for (const match of span.text.matchAll(new RegExp(pattern.source, flags))) {
    const index = span.start + (match.index ?? 0);
    const context = clinicalAssertionContextAt(text, index);
    if (context.subject !== "patient" || context.mood !== "actual" || context.temporality !== "current") continue;
    if (!isNegatedAt(text, index) && !isHistoricalOrResolvedAt(text, index, match[0].length)) return true;
  }
  return false;
}

function hasAnaphylacticAirwayEmergency(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  const upperAirwayEdema = /(?:喉头|咽喉|喉咙|声门|舌|口唇)[^，,。；;\n]{0,8}(?:水肿|肿胀|肿起|发肿)/g;
  for (const edema of normalized.matchAll(upperAirwayEdema)) {
    const index = edema.index ?? -1;
    if (index < 0) continue;
    const span = clinicalAssertionSpanAt(normalized, index);
    if (!hasAffirmedPatternInSpan(normalized, span, upperAirwayEdema)) continue;

    const afterEdema = normalized.slice(index + edema[0].length, span.end);
    if (/^(?:[^，,]{0,16})?(?:(?:现已|目前已|已经|已)(?:消退|消肿|缓解|消失|恢复)|治疗后(?:消退|消肿|缓解|消失|恢复))/.test(afterEdema)) continue;

    const exposure = hasAffirmedPatternInSpan(
      normalized,
      span,
      /(?:进食|食用|吃(?:了)?|服用|口服|注射|输注|接触)[^，,。；;\n]{0,18}(?:后|之后|随即|即刻)|(?:过敏|暴露)[^，,。；;\n]{0,10}(?:后|导致|引起)/,
    );
    const rapid = hasAffirmedPatternInSpan(
      normalized,
      span,
      /(?:迅速|快速|突然|突发|即刻|随即|很快|数分钟内|短时间内)/,
    );
    const airwayDysfunction = [
      /(?:声音嘶哑|声嘶|发声困难|说话困难)/,
      /(?:吞咽困难|不能吞咽|吞不下)/,
      /(?:呼吸困难|喘憋|喉鸣|喘鸣|吸气困难)/,
      /(?:咽喉|喉头|喉咙)[^，,。；;\n]{0,8}(?:发紧|紧缩|堵塞感)/,
    ].filter((pattern) => hasAffirmedPatternInSpan(normalized, span, pattern)).length;

    // Current upper-airway edema is itself dangerous; exposure, rapid onset, or a concurrent
    // airway-function change establishes that the finding belongs to the active reaction episode.
    if (exposure || rapid || airwayDysfunction > 0) return true;
  }
  // Some patients describe upper-airway compromise as obstruction/tightness rather than visible
  // swelling. Require the full episode signature (recent exposure + allergic manifestation +
  // airway/breathing/circulation involvement) so this remains a high-specificity catastrophe floor.
  const recentExposure = hasPatternWithoutNegation(
    normalized,
    /(?:进食|食用|吃(?:了)?|服用|口服|注射|输注|接触)[^。；;\n]{0,24}(?:后|之后|随即|即刻)/,
  );
  const allergicManifestation = hasPatternWithoutNegation(
    normalized,
    /(?:全身)?(?:荨麻疹|风团|皮疹)|(?:口唇|眼睑|面部|舌)(?:肿|肿胀)|过敏反应/,
  );
  const airwayBreathingCirculation = hasPatternWithoutNegation(
    normalized,
    /(?:喉头|咽喉|喉咙)[^。；;\n]{0,10}(?:阻塞感|堵塞感|发紧|紧缩)|呼吸困难|喘憋|喉鸣|声音嘶哑|晕厥|意识淡漠/,
  ) || ((parseContextualSpo2(normalized) ?? 100) <= 91) || bloodPressureIsCritical(parseContextualBloodPressure(normalized));
  if (recentExposure && allergicManifestation && airwayBreathingCirculation) return true;
  return false;
}

function hasAnyTerm(text: string, terms: string[]): boolean {
  return terms.some((term) => hasTerm(text, term));
}

function hasPatternWithoutNegation(text: string, pattern: RegExp): boolean {
  const source = pattern.source;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(source, flags);
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    if (isExcludedClinicalAssertionAt(text, index)) continue;
    if ((!isNegatedAt(text, index) || hasCommaSeparatedPositiveEvidence(text, index, match[0])) &&
        !isHistoricalOrResolvedAt(text, index, match[0].length)) return true;
  }
  return false;
}

function hasAcuteAbdominalTimeline(value: string): boolean {
  if (/(刚刚|刚才|方才|今日|今天|今晨|今早|昨日|昨日起|昨夜开始|昨晚开始)/.test(value)) return true;
  if (/(?:半|一|二|两|三|四|五|六|七|数|几)\s*(?:分钟|分|小时|天|日)/.test(value)) return true;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*(分钟|分|小时|天|日)/g)) {
    const duration = Number(match[1]);
    if (match[2] === "分钟" || match[2] === "分" || match[2] === "小时" || duration <= 7) return true;
  }
  return false;
}

function hasAcuteAbdominalPersistence(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  for (const term of ["腹痛", "腹胀"]) {
    let index = normalized.indexOf(term);
    while (index !== -1) {
      if (isExcludedClinicalAssertionAt(normalized, index)) {
        index = normalized.indexOf(term, index + term.length);
        continue;
      }
      const affirmed = !isNegatedAt(normalized, index) || hasCommaSeparatedPositiveEvidence(normalized, index, term);
      if (affirmed && !isHistoricalOrResolvedAt(normalized, index, term.length)) {
        const clauseStart = Math.max(
          normalized.lastIndexOf("。", index - 1),
          normalized.lastIndexOf("；", index - 1),
          normalized.lastIndexOf(";", index - 1),
          normalized.lastIndexOf("\n", index - 1),
        ) + 1;
        const clauseEndCandidates = ["。", "；", ";", "\n"]
          .map((mark) => normalized.indexOf(mark, index))
          .filter((position) => position >= 0);
        const clauseEnd = clauseEndCandidates.length > 0 ? Math.min(...clauseEndCandidates) : normalized.length;
        const localClause = normalized.slice(Math.max(clauseStart, index - 24), Math.min(clauseEnd, index + term.length + 48));
        const persists = /(?:仍|一直|反复)?持续(?:存在|不缓解)?|(?:未|无|没有|尚未)(?:见)?(?:缓解|好转|改善)/.test(localClause);
        if (persists && hasAcuteAbdominalTimeline(localClause)) return true;
      }
      index = normalized.indexOf(term, index + term.length);
    }
  }
  return false;
}

function hasAcuteAbdominalSignal(text: string): boolean {
  // 腹膜刺激征的口语表达（“按下去松手更疼”=反跳痛）与“肚子疼”类口语主诉必须覆盖；
  // 松手后“不疼”的否定式描述不命中（间隔字符排除不/无/未）。
  return hasAnyTerm(text, ["急腹痛", "板状腹", "反跳痛", "腹膜刺激征", "腹肌紧张"]) ||
    hasPatternWithoutNegation(text, /(?:松手|放手|抬手|松开)(?:时|后)?[^，,。；;\n不无未]{0,4}(?:更|最|特别)?(?:疼|痛)/) ||
    hasPatternWithoutNegation(text, /(?:急性|突发|突然|剧烈|快速加重|明显加重|很快|迅速|持续加重).{0,12}(?:腹痛|腹胀|肚子疼|肚子痛|肚子胀|全腹[^。；;\n]{0,4}痛)|(?:腹痛|腹胀|肚子疼|肚子痛|肚子胀|全腹[^。；;\n]{0,4}痛).{0,10}(?:急性|突发|突然|剧烈|快速加重|明显加重|很快加重|迅速加重|持续加重)/) ||
    hasAcuteAbdominalPersistence(text);
}

function clinicalClauseBounds(text: string, index: number): { start: number; end: number } {
  const start = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const following = ["。", "；", ";", "\n"]
    .map((mark) => text.indexOf(mark, index))
    .filter((position) => position >= 0);
  return { start, end: following.length > 0 ? Math.min(...following) : text.length };
}

function hasAcutePositiveTerm(text: string, terms: string[]): boolean {
  const acuteCue = /(突发|急性|新发|突然|持续|加重|快速加重|端坐|昨日起|昨夜开始|活动后|运动后|劳累后)/;
  for (const term of terms) {
    let index = text.indexOf(term);
    while (index !== -1) {
      if (isExcludedClinicalAssertionAt(text, index)) {
        index = text.indexOf(term, index + term.length);
        continue;
      }
      if ((!isNegatedAt(text, index) || hasCommaSeparatedPositiveEvidence(text, index, term)) && !isHistoricalOrResolvedAt(text, index, term.length)) {
        const clause = clinicalClauseBounds(text, index);
        const start = Math.max(clause.start, index - 12);
        const end = Math.min(clause.end, index + term.length + 12);
        const windowText = text.slice(start, end).replace(NON_NEGATING_PHRASES, "");
        if (acuteCue.test(windowText)) return true;
      }
      index = text.indexOf(term, index + term.length);
    }
  }
  return false;
}

function hasRecentPositiveTerm(text: string, terms: string[]): boolean {
  const normalized = normalizeClinicalText(text);
  const recentCue = /(\d+(?:\.\d+)?\s*(?:分钟|分|小时|天|日|h|H)|[一二两三四五六七八九十几两]\s*(?:天|日)|半小时|半日|半天|一天|数小时|几小时|多小时|刚刚|刚才|方才|今日|今天|今晨|当前|现在|目前|昨日|昨日起|昨夜|昨晚|近期|近来|最近|近(?:(?:\d+|[一二两三四五六七八九十几两])?[日天]|两天|几天)|本次|新近|新发|再发|复发|又发|又有|突发|突然|急性|持续|加重|快速加重|活动后|运动后|劳累后)/;
  for (const term of terms) {
    let index = normalized.indexOf(term);
    while (index !== -1) {
      if (isExcludedClinicalAssertionAt(normalized, index)) {
        index = normalized.indexOf(term, index + term.length);
        continue;
      }
      const start = Math.max(0, index - 24);
      const end = Math.min(normalized.length, index + term.length + 24);
      const windowText = normalized.slice(start, end).replace(NON_NEGATING_PHRASES, "");
      const afterTerm = normalized.slice(index + term.length, index + term.length + 18).replace(NON_NEGATING_PHRASES, "");
      // “否认胸痛、头痛，今晨气促/气促持续2小时”中的逗号开启了新的阳性分句。
      // 仅当否定词与目标症状之间已经存在逗号时才覆盖继承否定；“否认气促，持续2小时”仍保持阴性。
      const separatedFromPriorNegation = hasCommaSeparatedPositiveEvidence(normalized, index, term);
      const resolvedAfterTerm = /^[^。；;\n]{0,16}(?:(?:现已|目前已|当前已|已经|已)(?:缓解|消失|好转)|(?:现|目前|当前)?(?:未再发|未出现)|(?:现|目前|当前)(?:无|没有)(?:气促|呼吸困难|喘憋|再发|症状|不适))/.test(afterTerm);
      if ((!isNegatedAt(normalized, index) || separatedFromPriorNegation) && !isHistoricalOrResolvedAt(normalized, index, term.length) && !resolvedAfterTerm && recentCue.test(windowText)) return true;
      index = normalized.indexOf(term, index + term.length);
    }
  }
  return false;
}

const FOCAL_NEUROLOGIC_TERMS = [
  "意识改变", "言语不清", "口齿不清", "构音不清", "说话含糊", "失语", "不能说话", "不能讲话",
  "言语理解障碍", "语言理解障碍", "肢体无力", "口角歪斜", "偏盲",
];
const FOCAL_NEUROLOGIC_PATTERN = /(?:意识改变|言语不清|口齿不清|构音不清|说话含糊|失语|不能说话|不能讲话|言语理解障碍|语言理解障碍|肢体无力|口角歪斜|偏盲)/;

function hasAcuteExtendedStrokeWarning(text: string): boolean {
  const acuteCue = /(?:刚刚|刚才|方才|今日|今天|今晨|昨日起|近\s*(?:\d+|[一二两三四五六七八九十几两]+)\s*(?:分钟|小时|天|日)|本次|当前|目前|新发|突发|突然|再发|复发)/;
  const extendedSign = /(?:(?:左|右|单|一|偏)侧|半身|偏身)[^。；;\n]{0,8}(?:麻木|感觉减退|感觉丧失|偏盲)|视物重影|复视|突然失明|视力骤降|视野缺损|偏盲|行走不稳|站立不稳|共济失调/;
  const acuteExtended = new RegExp(`${acuteCue.source}.{0,24}${extendedSign.source}`);
  const posteriorCombination = new RegExp(`${acuteCue.source}.{0,24}(?:眩晕|头晕).{0,20}(?:复视|视物重影|行走不稳|站立不稳|共济失调|吞咽困难|构音不清)|${acuteCue.source}.{0,24}(?:复视|视物重影|行走不稳|站立不稳|共济失调).{0,20}(?:眩晕|头晕)`);
  return hasPatternWithoutNegation(text, acuteExtended) || hasPatternWithoutNegation(text, posteriorCombination);
}

function hasStablePostAcuteNeurologicContext(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  const hasEstablishedNeurologicEvent =
    /(?:脑梗死|脑卒中|中风|脑出血|TIA|短暂性脑缺血发作|颅脑损伤|神经损伤)[^。；;\n]{0,28}(?:后|恢复期|康复期|后遗)/i.test(normalized) ||
    /(?:脑梗死|脑卒中|脑出血|中风|TIA|短暂性脑缺血发作)(?:恢复期|康复期|后遗症)/i.test(normalized) ||
    /(?:脑梗死|脑卒中|中风|脑出血|TIA|短暂性脑缺血发作)[^。；;\n]{0,32}(?:遗留|残留)[^。；;\n]{0,20}(?:无力|麻木|言语不清|口角歪斜|步态异常)/i.test(normalized);
  const hasNonAcuteCourse =
    /(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:周|个月|月|年)/.test(normalized);
  const hasCurrentStability =
    /(?:出院后|治疗后|恢复期|康复期|目前|当前|近(?:期|来|\d+个月|[一二两三四五六七八九十]+个月))[^。；;\n]{0,40}(?:病情稳定|稳定|逐渐改善|逐步恢复|无新发|未再发|无再发|无加重)/.test(normalized) ||
    /(?:病情稳定|恢复平稳|康复调理)[^。；;\n]{0,36}(?:无新发|未再发|无再发|无加重)?/.test(normalized);
  const explicitResidualBaseline = /(?:后遗|遗留|残留)[^。；;\n]{0,28}(?:无力|麻木|言语不清|口角歪斜|步态异常)/.test(normalized);
  const acuteChange = /(?:刚刚|刚才|今日|今天|今晨|新发|突发|突然|再发|复发|快速加重|明显加重|恶化)[^。；;\n]{0,28}(?:无力|麻木|言语不清|口角歪斜|步态异常)|(?:无力|麻木|言语不清|口角歪斜|步态异常)[^。；;\n]{0,20}(?:新发|再发|加重|恶化)/.test(normalized);
  return hasEstablishedNeurologicEvent && hasNonAcuteCourse && (hasCurrentStability || (explicitResidualBaseline && !acuteChange));
}

// 神经事件锚点与残留/急性线索（类别级，不含个案关键词）：用于区分「陈旧卒中残留/后遗症期」与
// 「旧卒中基础上的新发急性加重」。残留框架本身不是否定词，只是把时间轴限定为慢性基线；
// 一旦同一小句出现急性变化线索（突发/新发/再发/加重…），必须重新视为当前急症（fail-closed）。
const NEURO_EVENT_ANCHOR_SOURCE = String.raw`(?:脑梗(?:死|塞)?|脑卒中|卒中|中风|脑出血|脑溢血|脑血栓|脑栓塞|TIA|短暂性脑缺血发作|颅脑损伤|脑外伤|脑部手术|偏瘫)`;
const NEURO_RESIDUAL_MARKER_SOURCE = String.raw`(?:后遗(?:症)?(?:期)?|后遗症|遗留|残留|残存|陈旧(?:性)?|恢复期|康复期)`;
const NEURO_RESIDUAL_MARKER_PATTERN = new RegExp(NEURO_RESIDUAL_MARKER_SOURCE);
const NEURO_ACUTE_ONSET_CUE_SOURCE = String.raw`(?:刚刚|刚才|方才|今(?:日|天|晨|早|晚)|昨日|昨晚|昨夜|现在|目前|当前|本次|近日|近期|近(?:\d+|[一二两三四五六七八九十]+)\s*(?:小时|天|日|周)|新发|突发|突然|急性)`;
const NEURO_ACUTE_CHANGE_CUE_SOURCE = String.raw`(?:再发|复发|又发|加重|恶化|进展)`;
const NEURO_ACUTE_ANY_CUE_PATTERN = new RegExp(`${NEURO_ACUTE_ONSET_CUE_SOURCE}|${NEURO_ACUTE_CHANGE_CUE_SOURCE}`, "g");
const NEURO_ACUTE_CHANGE_ONLY_PATTERN = new RegExp(`^(?:${NEURO_ACUTE_CHANGE_CUE_SOURCE})$`);
const NEURO_HISTORICAL_ANCHOR_PATTERN = /(?:既往|曾经|曾|当时|陈旧|多年前|数年前|(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:年|个月|月|周|天|日)前)/;

// 逗号/顿号级小句边界（硬句边界之内）：急性线索只在其所修饰的小句内有效，
// 避免“今天突发胸痛，既往脑梗遗留肢体无力”里胸痛的急性词跨过逗号点燃陈旧神经缺损。
function clinicalSubClauseBoundsAt(text: string, index: number, length: number): { start: number; end: number } {
  const start = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
    text.lastIndexOf("，", index - 1),
    text.lastIndexOf(",", index - 1),
  ) + 1;
  const endCandidates = ["。", "；", ";", "\n", "，", ","]
    .map((mark) => text.indexOf(mark, index + Math.max(0, length)))
    .filter((position) => position >= 0);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : text.length;
  return { start, end };
}

// 急性线索本身必须未被否定、未被既往/陈旧时间锚点限定；纯时间/起病词若与缺损之间隔着
// 残留标记（“目前遗留右侧肢体无力”），描述的是慢性基线而非急性事件，不能算急性。
// 变化类动词（加重/再发/复发/恶化/进展）不受残留标记阻断：残留基础上加重本身就是卒中警示。
function neuroAcuteCueUsableAt(text: string, cueIndex: number, cueText: string, deficitIndex: number, isChangeVerb: boolean): boolean {
  // “肢体无力”的“无”是症状名词的一部分，不是否定词；掩码后再做否定判定（与输出清洗层同一手法），
  // 否则“中风后遗留左侧肢体无力，今日突然加重”里的加重会被误判为受否定。
  const masked = text.replace(/肢体无力/g, "肢体乏力");
  if (isNegatedAt(masked, cueIndex)) return false;
  const cueBounds = clinicalSubClauseBoundsAt(masked, cueIndex, cueText.length);
  if (NEURO_HISTORICAL_ANCHOR_PATTERN.test(masked.slice(cueBounds.start, cueIndex))) return false;
  if (!isChangeVerb && cueIndex + cueText.length <= deficitIndex &&
      NEURO_RESIDUAL_MARKER_PATTERN.test(masked.slice(cueIndex + cueText.length, deficitIndex))) return false;
  return true;
}

// 判断局灶神经缺损是否附着急性变化线索：同小句内的起病/变化词、前一小句句尾的起病短语
// （“今晨突发，右侧肢体无力”），或紧随其后小句句首的变化动词（“遗留右侧肢体无力，近2日加重”）。
function neuroAcuteChangeAttachedAt(text: string, index: number, matchText: string): boolean {
  const { start, end } = clinicalSubClauseBoundsAt(text, index, matchText.length);
  NEURO_ACUTE_ANY_CUE_PATTERN.lastIndex = 0;
  for (const match of text.slice(start, end).matchAll(NEURO_ACUTE_ANY_CUE_PATTERN)) {
    const cueIndex = start + (match.index ?? 0);
    if (cueIndex >= index && cueIndex < index + matchText.length) continue;
    const isChangeVerb = NEURO_ACUTE_CHANGE_ONLY_PATTERN.test(match[0]);
    if (neuroAcuteCueUsableAt(text, cueIndex, match[0], index, isChangeVerb)) return true;
  }
  if (start > 0) {
    const prevEnd = start - 1;
    const prevStart = prevEnd > 0 ? clinicalSubClauseBoundsAt(text, prevEnd - 1, 0).start : 0;
    const prevSegment = text.slice(prevStart, prevEnd);
    const onsetAtTail = prevSegment.match(new RegExp(`(${NEURO_ACUTE_ONSET_CUE_SOURCE})(?:出现|发生)?\\s*$`));
    if (onsetAtTail?.index != null &&
        neuroAcuteCueUsableAt(text, prevStart + onsetAtTail.index, onsetAtTail[1], index, false)) return true;
  }
  if (end < text.length) {
    const nextStart = end + 1;
    const nextEnd = clinicalSubClauseBoundsAt(text, nextStart, 0).end;
    const nextSegment = text.slice(nextStart, nextEnd);
    const changeAtHead = nextSegment.match(new RegExp(`^\\s*(?:(?:${NEURO_ACUTE_ONSET_CUE_SOURCE}|且|并|又)\\s*){0,3}(?:明显|显著|逐渐|渐进)?(${NEURO_ACUTE_CHANGE_CUE_SOURCE})`));
    if (changeAtHead?.index != null &&
        neuroAcuteCueUsableAt(text, nextStart + changeAtHead[0].length - changeAtHead[1].length, changeAtHead[1], index, true)) return true;
  }
  return false;
}

// 判断局灶神经缺损是否被明确框定为陈旧/残留/后遗症期基线：脑血管事件锚点 + 残留标记
// （“脑梗后遗症期”“中风后遗”“陈旧性脑梗…遗留”），或缺损小句内直接带残留标记。
// 不含急性线索的含混表述不进入此分支，保持 fail-closed（未知起病按当前处理）。
function neuroResidualFramingAt(text: string, index: number, matchText: string): boolean {
  const hardStart = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const before = text.slice(hardStart, index);
  const anchoredResidual = new RegExp(
    `${NEURO_EVENT_ANCHOR_SOURCE}[^。；;\\n]{0,24}${NEURO_RESIDUAL_MARKER_SOURCE}`,
  ).test(before);
  if (anchoredResidual) return true;
  const { start } = clinicalSubClauseBoundsAt(text, index, matchText.length);
  return NEURO_RESIDUAL_MARKER_PATTERN.test(text.slice(start, index));
}

function hasCurrentFocalNeurologicDeficit(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  for (const term of FOCAL_NEUROLOGIC_TERMS) {
    let index = normalized.indexOf(term);
    while (index >= 0) {
      const context = clinicalAssertionContextAt(normalized, index);
      const commaSeparatedPositive = hasCommaSeparatedPositiveEvidence(normalized, index, term);
      // 急性变化线索可覆盖“既往/半年前”级的历史时间框定（旧卒中 + 今突发必须仍然报警）；
      // 残留/后遗症框架则在无急性线索时压下慢性基线缺损（陈旧脑梗遗留无力不再误报急症）。
      const acuteChangeAttached = neuroAcuteChangeAttachedAt(normalized, index, term);
      const residualFraming = !acuteChangeAttached && neuroResidualFramingAt(normalized, index, term);
      if (
        context.subject === "patient" &&
        context.mood === "actual" &&
        (acuteChangeAttached || (context.temporality === "current" && !residualFraming)) &&
        (!isNegatedAt(normalized, index) || commaSeparatedPositive)
      ) {
        return true;
      }
      index = normalized.indexOf(term, index + term.length);
    }
  }
  return false;
}

// 劳力性慢性稳定型胸痛/胸闷 vs 慢性背景上的急性冠脉事件（类别级，不含个案关键词）。
// 与神经残留判别同一设计：劳力诱发 + 慢性病程/稳定性锚点 = 慢性稳定基线，不报急性红旗；
// 一旦出现急性变化线索（静息/夜间发作、新发/突发、进行性加重、不缓解），即使在慢性背景上也必须报警。
const CARDIAC_EXERTIONAL_TRIGGER_PATTERN = /(?:劳力性|劳力|活动后|运动后|劳累后|快走|快步|爬坡|爬楼|上楼|登高|提重物|体力活动)/;
const CARDIAC_CHRONIC_COURSE_PATTERN = /(?:(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:年|个月|月)|多年|数年|长期)/;
const CARDIAC_STABILITY_PATTERN = /(?:稳定型心绞痛|稳定性心绞痛|规律服药|规律用药|控制稳定|病情稳定|同前|无变化|无明显变化|平素)/;
const CARDIAC_ACUTE_ONSET_CUE_SOURCE = String.raw`(?:刚刚|刚才|方才|今(?:日|天|晨|早|晚)|昨日|昨晚|昨夜|近日|近期|近(?:\d+|[一二两三四五六七八九十]+)\s*(?:小时|天|日|周)|新发|突发|突然|急性|静息|夜间|痛醒|憋醒)`;
const CARDIAC_ACUTE_CHANGE_CUE_SOURCE = String.raw`(?:再发|复发|加重|恶化|进展|不缓解|难以缓解|频发|频繁|频作|进行性)`;
const CARDIAC_ACUTE_ANY_CUE_PATTERN = new RegExp(`${CARDIAC_ACUTE_ONSET_CUE_SOURCE}|${CARDIAC_ACUTE_CHANGE_CUE_SOURCE}`, "g");
const CARDIAC_ACUTE_CHANGE_ONLY_PATTERN = new RegExp(`^(?:${CARDIAC_ACUTE_CHANGE_CUE_SOURCE})$`);

// 胸痛/胸闷/心前区痛某一具体出现位置是否附着急性变化线索：同小句、前一小句句尾起病短语、
// 或紧随其后小句句首的变化动词。线索可用性（否定/历史锚点/残留阻断）复用神经层的通用判定。
function cardiacAcuteChangeAttachedAt(text: string, index: number, matchText: string): boolean {
  const { start, end } = clinicalSubClauseBoundsAt(text, index, matchText.length);
  CARDIAC_ACUTE_ANY_CUE_PATTERN.lastIndex = 0;
  for (const match of text.slice(start, end).matchAll(CARDIAC_ACUTE_ANY_CUE_PATTERN)) {
    const cueIndex = start + (match.index ?? 0);
    if (cueIndex >= index && cueIndex < index + matchText.length) continue;
    const isChangeVerb = CARDIAC_ACUTE_CHANGE_ONLY_PATTERN.test(match[0]);
    if (neuroAcuteCueUsableAt(text, cueIndex, match[0], index, isChangeVerb)) return true;
  }
  if (start > 0) {
    const prevEnd = start - 1;
    const prevStart = prevEnd > 0 ? clinicalSubClauseBoundsAt(text, prevEnd - 1, 0).start : 0;
    const prevSegment = text.slice(prevStart, prevEnd);
    const onsetAtTail = prevSegment.match(new RegExp(`(${CARDIAC_ACUTE_ONSET_CUE_SOURCE})(?:出现|发生|发作)?\\s*$`));
    if (onsetAtTail?.index != null &&
        neuroAcuteCueUsableAt(text, prevStart + onsetAtTail.index, onsetAtTail[1], index, false)) return true;
  }
  if (end < text.length) {
    const nextStart = end + 1;
    const nextEnd = clinicalSubClauseBoundsAt(text, nextStart, 0).end;
    const nextSegment = text.slice(nextStart, nextEnd);
    const changeAtHead = nextSegment.match(new RegExp(`^\\s*(?:(?:${CARDIAC_ACUTE_ONSET_CUE_SOURCE}|且|并|又)\\s*){0,3}(?:明显|显著|逐渐|渐进)?(${CARDIAC_ACUTE_CHANGE_CUE_SOURCE})`));
    if (changeAtHead?.index != null &&
        neuroAcuteCueUsableAt(text, nextStart + changeAtHead[0].length - changeAtHead[1].length, changeAtHead[1], index, true)) return true;
  }
  return false;
}

// 单个胸痛/胸闷出现位置是否被框定为劳力性慢性稳定基线：本小句带劳力诱发词，
// 且同一硬句内有慢性病程（2年/数月/多年）或稳定性/管理锚点（稳定型心绞痛/规律服药/控制同前）。
function cardiacMentionIsChronicStableAt(text: string, index: number, matchText: string): boolean {
  const { start, end } = clinicalSubClauseBoundsAt(text, index, matchText.length);
  if (!CARDIAC_EXERTIONAL_TRIGGER_PATTERN.test(text.slice(start, end))) return false;
  const hardStart = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const hardEndCandidates = ["。", "；", ";", "\n"]
    .map((mark) => text.indexOf(mark, index + matchText.length))
    .filter((position) => position >= 0);
  const hardEnd = hardEndCandidates.length > 0 ? Math.min(...hardEndCandidates) : text.length;
  const hardClause = text.slice(hardStart, hardEnd);
  return CARDIAC_CHRONIC_COURSE_PATTERN.test(hardClause) || CARDIAC_STABILITY_PATTERN.test(hardClause);
}

// 整段文本是否只有「劳力性慢性稳定」一种胸痛/胸闷叙事：每个未被排除/否定的提及都必须是
// 慢性稳定框架，且没有任何提及附着急性变化线索。任一提及是急性或含混（无劳力框架）→ false，
// 维持原有急性信号判定（fail-closed 保守报警）。
function hasChronicStableExertionalCardiacOnly(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  let sawMention = false;
  for (const term of ["胸痛", "心前区痛", "胸闷"]) {
    let index = normalized.indexOf(term);
    while (index >= 0) {
      if (!isExcludedClinicalAssertionAt(normalized, index) && !isNegatedAt(normalized, index)) {
        sawMention = true;
        if (!cardiacMentionIsChronicStableAt(normalized, index, term)) return false;
        if (cardiacAcuteChangeAttachedAt(normalized, index, term)) return false;
      }
      index = normalized.indexOf(term, index + term.length);
    }
  }
  return sawMention;
}

function firstPatternMatchWithoutNegation(text: string, pattern: RegExp): { index: number; text: string } | undefined {  const source = pattern.source;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(source, flags);
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    if (isExcludedClinicalAssertionAt(text, index)) continue;
    if ((!isNegatedAt(text, index) || hasCommaSeparatedPositiveEvidence(text, index, match[0])) &&
        !isHistoricalOrResolvedAt(text, index, match[0].length)) return { index, text: match[0] };
  }
  return undefined;
}

function hasNeurologicEmergencySignal(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  const stablePostAcuteCourse = hasStablePostAcuteNeurologicContext(normalized);
  const extendedStrokeWarning = hasAcuteExtendedStrokeWarning(normalized);
  const unilateralSensoryMatch = firstPatternMatchWithoutNegation(
    normalized,
    /(?:(?:左|右|单|一|偏)侧|半身|偏身)[^。；;\n]{0,12}(?:麻木|感觉减退|感觉丧失|偏盲)/,
  );
  // 与局灶缺损同一判别口径：陈旧/残留框架下的慢性感觉缺损不报急症；附着急性变化线索时仍报。
  const activeUnilateralSensoryDeficit = unilateralSensoryMatch != null &&
    (neuroAcuteChangeAttachedAt(normalized, unilateralSensoryMatch.index, unilateralSensoryMatch.text) ||
      !neuroResidualFramingAt(normalized, unilateralSensoryMatch.index, unilateralSensoryMatch.text));
  if (stablePostAcuteCourse) {
    const acuteCueBeforeDeficit = new RegExp(`(?:刚刚|刚才|方才|今日|今天|今晨|昨日起|近\\s*(?:\\d+|[一二两三四五六七八九十几两]+)\\s*(?:小时|天|日)|本次|当前|目前|新发|突发|突然|再发|复发|快速加重|明显加重).{0,20}(?:出现|发生|再发|复发|加重)?[^。；;\\n]{0,8}${FOCAL_NEUROLOGIC_PATTERN.source}`);
    const acuteCueAfterDeficit = new RegExp(`${FOCAL_NEUROLOGIC_PATTERN.source}[^。；;\\n]{0,20}(?:(?:刚刚|刚才|方才|今日|今天|今晨|昨日起|本次|当前|目前)(?:突然)?(?:出现|发生|再发|复发|加重|恶化)|(?<!无)(?<!未)(?:新发|突发|突然|再发|复发|快速加重|明显加重|恶化))`);
    return extendedStrokeWarning || hasPatternWithoutNegation(text, acuteCueBeforeDeficit) || hasPatternWithoutNegation(text, acuteCueAfterDeficit) ||
      hasPatternWithoutNegation(text, new RegExp(`(?:病情|康复)(?:原本|曾经|一直)?稳定[^。；;\\n]{0,30}(?:但|然而|现|目前|当前)[^。；;\\n]{0,12}${FOCAL_NEUROLOGIC_PATTERN.source}[^。；;\\n]{0,8}(?:加重|恶化|再发|复发)`));
  }
  const explicitAcuteChange = hasCurrentFocalNeurologicDeficit(text);
  if (explicitAcuteChange) return true;
  if (extendedStrokeWarning) return true;
  if (activeUnilateralSensoryDeficit) return true;
  // Unknown-onset focal deficits are current by default. Historical, negated, conditional, or
  // non-patient mentions must not be promoted back to an emergency by this deterministic floor.
  return hasCurrentFocalNeurologicDeficit(text);
}

// 陈旧/既往标记：一个「心电图正常」「已急诊评估排除」若被这些词限定，说明是既往/历史结论，
// 不能用来清除本次的活动性急性表现（否则会出现 fail-open：陈旧正常心电图漏报当前急性胸痛）。
const CARDIAC_STALENESS_MARKERS = /(既往|曾经|曾有|曾|陈旧|以前|之前|从前|过去|当年|当时|去年|前年|昨日|昨天|昨晨|昨晚|昨夜|前日|前天|上[周月次年]|前几[天日]|(?:24|二十四)\s*(?:小时|h)前|(?:[一二两三四五六七八九十半数几多]|\d+)\s*(?:年|个月|月|周|天|日|小时)前|多年前)/;

function hasApplicableRelativeStaleness(beforeClearance: string): boolean {
  const regex = new RegExp(CARDIAC_STALENESS_MARKERS.source, "g");
  let last: RegExpMatchArray | undefined;
  for (const match of beforeClearance.matchAll(regex)) last = match;
  if (!last || last.index == null) return false;
  const tail = beforeClearance.slice(last.index + last[0].length);
  // “曾有心前区痛，已由心内科明确非急症”中的历史词修饰症状，不修饰逗号后的当前结论。
  if (/(胸痛|心前区痛|胸闷|气促|呼吸困难|晕厥|黑矇|意识丧失)/.test(tail)) return false;
  // 明确的本次/今日锚点重新开启当前临床结论。
  if (/(今日|今天|本次|当前|现在|目前).{0,16}$/.test(tail)) return false;
  return true;
}

function hasStaleAbsoluteDate(value: string): boolean {
  const clinicalDateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const clinicalPart = (type: "year" | "month" | "day") => Number(clinicalDateParts.find((part) => part.type === type)?.value);
  const currentYear = clinicalPart("year");
  const currentMonth = clinicalPart("month");
  const currentDay = clinicalPart("day");
  const full = value.match(/(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})(?:日)?/);
  // 无年份只接受明确的中文月日写法；裸“36.6”“122/76”更可能是体温或血压，不能按日期处理。
  const partial = full ? null : value.match(/(?:^|[^\d])(\d{1,2})月(\d{1,2})日/);
  if (!full && !partial) return false;
  const year = full ? Number(full[1]) : currentYear;
  const month = Number(full ? full[2] : partial![1]);
  const day = Number(full ? full[3] : partial![2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const invalid = date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day;
  if (invalid) return true;
  const clinicalToday = Date.UTC(currentYear, currentMonth - 1, currentDay);
  // 只认中国临床时区的“今天”；昨天及更早是陈旧证据，未来日期是无效证据，均不能清除当前红旗。
  return date.getTime() !== clinicalToday;
}

function isStaleAt(text: string, index: number, matchText = ""): boolean {
  const hardClauseStart = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const hardClauseEndCandidates = ["。", "；", ";", "\n"]
    .map((mark) => text.indexOf(mark, index + matchText.length))
    .filter((position) => position >= 0);
  const hardClauseEnd = hardClauseEndCandidates.length > 0 ? Math.min(...hardClauseEndCandidates) : text.length;
  const hardClause = text.slice(hardClauseStart, hardClauseEnd);
  const hardBefore = text.slice(hardClauseStart, index);
  const softClauseStart = Math.max(text.lastIndexOf("，", index - 1), text.lastIndexOf(",", index - 1), hardClauseStart - 1) + 1;
  const before = text.slice(Math.max(softClauseStart, index - 32), index);
  const after = text.slice(index + matchText.length, index + matchText.length + 32);
  const windowText = `${before}${matchText}${after}`;
  return CARDIAC_STALENESS_MARKERS.test(windowText) || hasApplicableRelativeStaleness(hardBefore) || hasStaleAbsoluteDate(hardClause);
}

// 返回未被否定、且未被陈旧/既往标记限定的最后一个匹配的结束位置（无则 -1）。
function lastPatternEndFresh(text: string, pattern: RegExp): number {
  const source = pattern.source;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(source, flags);
  let lastEnd = -1;
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? -1;
    const clauseStart = Math.max(text.lastIndexOf("。", index - 1), text.lastIndexOf("；", index - 1), text.lastIndexOf(";", index - 1), text.lastIndexOf("\n", index - 1)) + 1;
    const polarityWindow = `${text.slice(Math.max(clauseStart, index - 12), index)}${match[0]}`;
    const uncertainOrPending = /(尚未|不能|未能|无法|未予|建议|需|待|考虑)/.test(polarityWindow);
    if (index < 0 || uncertainOrPending || isNegatedAt(text, index) || isStaleAt(text, index, match[0])) continue;
    lastEnd = Math.max(lastEnd, index + match[0].length);
  }
  return lastEnd;
}

function acuteCardiacClearanceBoundary(text: string): number {
  const normalized = normalizeClinicalText(text);
  // 清除只认「本次/近期」的临床评估与客观检查；陈旧/既往结论不清除当前急性表现（fail-closed）。
  const clinicianClearedEnd = lastPatternEndFresh(
    normalized,
    /(?:(?:(?:今日|今天|本次|当前|已|已经|经|由)[^，,。；;\n]{0,8})?(?:急诊|心内科|心血管|医院|医生|专科|上级医院).{0,24}(?:已明确排除|明确排除|已排除|评估后明确排除|评估明确排除|评估排除|评估为|诊断为|会诊明确).{0,24}(?:非急症|非急危重|急性冠脉|ACS|心梗|心肌梗死|急性心血管事件|危险|危急|肋软骨炎)|(?:今日|今天|本次|当前)?(?:已|已经)?明确(?:由|经)(?:急诊|心内科|心血管|医院|医生|专科|上级医院).{0,12}排除.{0,12}(?:急性冠脉|ACS|心梗|心肌梗死|急性心血管事件|危险|危急)|(?:今日|今天|本次|当前)?(?:已|已经)?明确排除.{0,12}(?:急性冠脉|ACS|心梗|心肌梗死|急性心血管事件|危险|危急).{0,12}(?:经|由)?(?:急诊|心内科|心血管|医院|医生|专科|上级医院)(?:确认|评估确认))/i,
  );
  // 单次心电图和肌钙蛋白不能脱离采样时序、连续检测与临床路径独立排除 ACS。
  return clinicianClearedEnd;
}

function hasCurrentOrRecurrentPositiveTerm(text: string, terms: string[]): boolean {
  const normalized = normalizeClinicalText(text);
  const cue = /(本次|本轮|现在|现|目前|当前|今日|今天|再发|复发|仍有|仍感|持续|加重|突发|突然|新发|未缓解|无缓解|没有缓解|\d+(?:\.\d+)?\s*(?:分钟|分|小时|h|H)|半小时|数小时)/;
  const postCue = /(仍有|仍感|持续|再发|复发|未缓解|无缓解|没有缓解|未见缓解|尚未缓解|没有好转|无好转|未改善|没有改善|加重|压榨|濒死|\d+(?:\.\d+)?\s*(?:分钟|分|小时|h|H)|半小时|数小时)/;
  for (const term of terms) {
    let index = normalized.indexOf(term);
    while (index !== -1) {
      if (isExcludedClinicalAssertionAt(normalized, index)) {
        index = normalized.indexOf(term, index + term.length);
        continue;
      }
      if (hasAnaphoricRecurrenceAfter(normalized, index, term)) return true;
      if (!isNegatedAt(normalized, index) || hasCommaSeparatedPositiveEvidence(normalized, index, term)) {
        // A current-time word inside a resolved phrase such as "目前无再发"
        // must not reactivate a historical symptom. True recurrence remains positive
        // because isHistoricalOrResolvedAt returns false when the symptom has recurred.
        if (isHistoricalOrResolvedAt(normalized, index, term.length)) {
          index = normalized.indexOf(term, index + term.length);
          continue;
        }
        const clause = clinicalClauseBounds(normalized, index);
        const start = Math.max(clause.start, index - 24);
        const end = Math.min(clause.end, index + term.length + 28);
        const windowText = normalized.slice(start, end).replace(NON_NEGATING_PHRASES, "");
        const after = normalized.slice(index + term.length, end).replace(NON_NEGATING_PHRASES, "");
        if (cue.test(windowText) || postCue.test(after)) return true;
      }
      index = normalized.indexOf(term, index + term.length);
    }
  }
  return false;
}

function hasPositiveCardiacSignalAfterClearance(text: string, clearanceBoundary: number): boolean {
  const normalized = normalizeClinicalText(text);
  const afterClearance = normalized.slice(Math.max(0, clearanceBoundary));
  const cardiacSymptoms = ["胸痛", "心前区痛", "胸闷"];
  const cardiacCompanions = ["大汗", "放射痛", "压榨", "濒死", "气促", "呼吸困难"];
  return (
    hasCurrentOrRecurrentPositiveTerm(afterClearance, [...cardiacSymptoms, ...cardiacCompanions]) ||
    hasRecentPositiveTerm(afterClearance, cardiacSymptoms) ||
    hasAcutePositiveTerm(afterClearance, cardiacSymptoms) ||
    (hasAnyTerm(afterClearance, cardiacSymptoms) && hasAnyTerm(afterClearance, cardiacCompanions))
  );
}

const MENTAL_HEALTH_CRISIS_TERMS = [
  "自杀", "轻生", "不想活", "不愿活", "结束生命", "自伤", "割腕", "跳楼", "服毒", "伤害自己", "伤害他人", "他伤",
];

function hasCurrentMentalHealthCrisis(text: string): boolean {
  for (const term of MENTAL_HEALTH_CRISIS_TERMS) {
    let index = text.indexOf(term);
    while (index >= 0) {
      const before = text.slice(Math.max(0, index - 24), index);
      const after = text.slice(index + term.length, index + term.length + 64);
      const recommendationOnly = /(?:筛查|询问|评估|排除|关注|观察|监测|风险|预防)[^。；;\n]{0,10}$/.test(before);
      const historicalNowNegative = /(?:既往|曾经|曾有|过去|多年前|上次)[^。；;\n]{0,16}$/.test(before) &&
        /(?:目前|当前|现在|现)[^。；;\n]{0,24}(?:否认|无|没有|未见)[^。；;\n]{0,12}(?:意念|想法|计划|行为|倾向|再发)?/.test(after);
      const excludedContext = isExcludedClinicalAssertionAt(text, index) || isHistoricalOrResolvedAt(text, index, term.length);
      if (!isNegatedAt(text, index) && !excludedContext && !recommendationOnly && !historicalNowNegative) return true;
      index = text.indexOf(term, index + term.length);
    }
  }
  return false;
}

function mentalHealthSafetyScreenRequired(text: string): boolean {
  return hasAnyTerm(text, ["情绪低落", "明显抑郁", "重度抑郁", "绝望", "无望", "活着没意思", "兴趣丧失", "精神崩溃", "严重焦虑"]);
}

function hasExplicitMentalHealthSafetyScreen(text: string): boolean {
  return /(?:否认|无|没有|未见|未出现|从无)[^。；;\n]{0,24}(?:自杀|轻生|不想活|自伤|伤害自己|伤害他人|他伤)(?:意念|想法|计划|行为|倾向)?/.test(text) ||
    /(?:自杀|轻生|自伤|伤害自己|伤害他人|他伤)(?:意念|想法|计划|行为|倾向)?[^。；;\n]{0,16}(?:阴性|否认|无|没有|未见)/.test(text);
}

function insomniaPresentation(text: string): boolean {
  return hasAnyTerm(text, ["失眠", "入睡困难", "难以入睡", "易醒", "早醒", "睡眠差", "睡眠障碍"]);
}

function hasExplicitOsaScreen(text: string): boolean {
  const domains = [/(?:打鼾|鼾声)/, /(?:睡眠中)?呼吸暂停|憋醒/, /(?:白天|日间)(?:嗜睡|困倦|疲乏)/, /高血压|血压/];
  return domains.filter((pattern) => {
    const match = text.match(pattern);
    if (!match || match.index == null) return false;
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 12);
    return !/(?:需|需要|待|尚待|未问|未询问|不详|未知|待核实)[^。；;\n]{0,10}$/.test(before) &&
      !/^(?:不详|未知|待核实|待询问)/.test(after);
  }).length >= 3;
}

function thyroidScreenRequired(text: string): boolean {
  const triggerGroups = [
    ["心悸", "心动过速", "脉搏快"],
    ["体重下降", "消瘦", "体重增加"],
    ["怕热", "怕冷", "多汗", "手抖", "震颤", "突眼"],
    ["焦虑", "烦躁"],
  ];
  return triggerGroups.filter((terms) => hasAnyTerm(text, terms)).length >= 2;
}

function hasCurrentThyroidAssessment(text: string): boolean {
  return /(?:本次|近期|近一个月|当前|今日|今天)?[^。；;\n]{0,12}(?:甲功|甲状腺功能|TSH|FT3|FT4)[^。；;\n]{0,28}(?:正常|未见异常|异常|升高|降低|阳性|阴性|待复查|待检查)/i.test(text);
}

export function detectProgrammaticRedFlags(state: CaseState): string[] {
  const text = trustedInputText(state);
  const vitalText = vitalsText(state);
  const redFlags: string[] = [];
  // The semantic ensemble owns broad natural-language triage. These few catastrophic narrative
  // checks are an always-on lower bound: a signed empty model result can never erase an already
  // explicit time-sensitive emergency. This layer only adds; same-episode clearance remains handled
  // by the existing temporal/polarity contract below.
  const vitalBp = parseContextualBloodPressure(vitalText);
  const narrativeBp = parseContextualBloodPressure(text);
  const bp = bloodPressureIsCritical(narrativeBp) ? narrativeBp : vitalBp ?? narrativeBp;
  const temp = preferAbnormalNumber(parseContextualTemperature(vitalText), parseContextualTemperature(text), (value) => value >= 38.5 || value < 36);
  const pulse = preferAbnormalNumber(parseContextualPulse(vitalText), parseContextualPulse(text), (value) => value >= 120 || value < 50);
  const respiration = preferAbnormalNumber(parseContextualRespiration(vitalText), parseContextualRespiration(text), (value) => value >= 25 || value < 8);
  const spo2 = preferAbnormalNumber(parseContextualSpo2(vitalText), parseContextualSpo2(text), (value) => value <= 91);
  const invertedCriticalBp = criticalInvertedBloodPressure(`${vitalText}\n${text}`);
  if (hasCurrentMentalHealthCrisis(text)) {
    redFlags.push("已出现自杀、自伤或伤害他人的意念/计划/行为线索，需立即进行现场安全评估并联系精神专科或急诊处置，不得仅依赖自动分级");
  }
  if (invertedCriticalBp) {
    redFlags.push(`血压录入 ${invertedCriticalBp.first}/${invertedCriticalBp.second}mmHg 疑似收缩压/舒张压倒置且包含危急值，不能静默纠正；需立即规范复测并按高血压危象或循环风险完成现场评估`);
  }

  const colloquialChestPressureSignal = hasPatternWithoutNegation(
    text,
    /(?:胸口|胸前|胸部|胸骨后|心口|心前区).{0,10}(?:(?:像|跟|如同).{0,5})?(?:石头|重物|东西)?(?:压着|压住|压得|压迫|发紧|勒紧|箍紧|堵得慌|闷得慌)/,
  );
  const chestPainSignal = hasAnyTerm(text, ["胸痛", "心前区痛"]) || colloquialChestPressureSignal;
  const chestTightnessSignal = hasAnyTerm(text, ["胸闷"]);
  // 劳力性慢性稳定型（劳力诱发 + 慢性病程/规律服药/控制稳定，无急性变化线索）不是急性冠脉
  // 待排情形，降级急性信号；静息/夜间/新发/突发/加重/不缓解等急性线索附着时不受影响。
  const chronicStableExertionalCardiacOnly = hasChronicStableExertionalCardiacOnly(text);
  const acuteChestPainSignal = !chronicStableExertionalCardiacOnly && (
    hasAcutePositiveTerm(text, ["胸痛", "心前区痛"]) ||
    hasRecentPositiveTerm(text, ["胸痛", "心前区痛"]) ||
    hasCurrentOrRecurrentPositiveTerm(text, ["胸痛", "心前区痛"]) ||
    (colloquialChestPressureSignal && /(?:突然|突发|刚才|刚刚|新发|开始|持续|不缓解|无缓解|冷汗|大汗|气促|呼吸困难|\d+(?:\.\d+)?\s*(?:分钟|分|小时))/.test(text)));
  const acuteChestTightnessSignal = !chronicStableExertionalCardiacOnly && (
    hasAcutePositiveTerm(text, ["胸闷"]) ||
    hasCurrentOrRecurrentPositiveTerm(text, ["胸闷"]));
  const cardiacCompanion = hasAnyTerm(text, ["大汗", "冷汗", "一身汗", "放射痛", "压榨", "濒死", "气促", "呼吸困难"]);
  const cardiacClearanceBoundary = acuteCardiacClearanceBoundary(text);
  const cardiacCleared = cardiacClearanceBoundary >= 0;
  const activeCardiacAfterClearance = cardiacCleared && hasPositiveCardiacSignalAfterClearance(text, cardiacClearanceBoundary);
  const cardiacClearanceApplies = cardiacCleared && !activeCardiacAfterClearance;
  const acuteAbdominalSignal = hasAcuteAbdominalSignal(text);
  const anaphylacticAirwaySignal = hasAnaphylacticAirwayEmergency(text);
  const recurrentGiBleedingSignal = text
    .split(/[，,。；;\n]+/)
    .some((clause) => hasPatternWithoutNegation(
      clause,
      /(?:再次|再发|复发)[^。；;\n]{0,12}(?:呕血|吐血|黑便|柏油样便|便血)/,
    ));
  const combinedUpperAndLowerGiBleedingSignal =
    hasAnyTerm(text, ["呕血", "吐血"]) && hasAnyTerm(text, ["黑便", "柏油样便", "便血"]);
  const activeGiBleedingSignal =
    recurrentGiBleedingSignal || combinedUpperAndLowerGiBleedingSignal ||
    hasAnyTerm(text, ["呕咖啡样物", "咖啡样呕吐物"]) ||
    hasPatternWithoutNegation(text, /(?:大量|反复|多次|再次|再发|复发|喷射|不止|持续出血)[^。；;\n]{0,16}(?:呕血|吐血|黑便|柏油样便|便血)|(?:呕血|吐血|黑便|柏油样便|便血)[^。；;\n]{0,20}(?:[2-9]\s*次|两次|三次|大量|反复|多次|再次|再发|复发|喷射|不止|头晕|乏力|晕厥|黑矇|意识改变|冷汗|心悸|面色苍白)/);
  const activeObstetricHemorrhageSignal =
    hasPatternWithoutNegation(text, /(?:孕|妊娠|怀孕)[^。；;\n]{0,40}(?:大量|大出血|持续|反复|鲜红色|血块|浸湿)[^。；;\n]{0,12}(?:阴道)?(?:出血|流血)/) ||
    hasPatternWithoutNegation(text, /(?:阴道)?(?:出血|流血)[^。；;\n]{0,30}(?:大量|大出血|持续|反复|鲜红色|血块|浸湿)[^。；;\n]{0,30}(?:孕|妊娠|怀孕)/);
  const cardiacRiskFlagged = !cardiacClearanceApplies && (acuteChestPainSignal || (chestPainSignal && cardiacCompanion) || acuteChestTightnessSignal || (chestTightnessSignal && cardiacCompanion));
  const reportableCardiacRisk = cardiacRiskFlagged;
  if (reportableCardiacRisk) {
    redFlags.push(((acuteChestTightnessSignal || chestTightnessSignal) && cardiacCompanion) || (chestPainSignal && cardiacCompanion)
      ? "胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件"
      : acuteChestTightnessSignal
        ? "急性或加重胸闷已出现，需先排除急性冠脉综合征等心血管风险"
      : "短时程、新发、突发或持续胸痛/心前区痛已出现，即使暂未记录伴随症状，也需先排除急性心血管事件");
  }
  if (hasPatternWithoutNegation(text, /(?:突发|突然|雷击|爆炸).{0,8}头痛/) || hasNeurologicEmergencySignal(text)) {
    redFlags.push("突发剧烈头痛、意识或神经功能异常，需优先排除神经系统急症");
  }
  if (acuteAbdominalSignal) {
    redFlags.push("急性、突发或剧烈腹痛/腹胀已出现，需先排除急腹症等风险");
  }
  if (anaphylacticAirwaySignal) {
    redFlags.push("急性过敏反应伴喉头或上气道肿胀线索，需立即评估气道、呼吸和循环并急诊处置");
  }
  if (activeGiBleedingSignal) {
    redFlags.push("当前呕血、咖啡样呕吐物、黑便或便血提示活动性消化道出血风险，需立即评估循环状态并急诊处置");
  }
  if (activeObstetricHemorrhageSignal) {
    redFlags.push("妊娠期活动性大量阴道出血提示产科急症，需立即转产科急诊评估");
  }
  const acuteRespiratorySignal =
    hasAnyTerm(text, ["端坐呼吸", "不能平卧", "无法平卧", "喘不上气", "口唇发紫", "嘴唇发紫"]) ||
    hasPatternWithoutNegation(text, /(?:说|讲)(?:半句|一句|几句话).{0,12}(?:停|歇|喘)|(?:静息|坐着不动).{0,8}(?:呼吸困难|气促|喘憋)/);
  // 胸痛/胸闷伴气促时，心血管红旗文案已经完整承接呼吸循环风险；避免同一事件重复成两条告警。
  if (acuteRespiratorySignal && !reportableCardiacRisk && !anaphylacticAirwaySignal) {
    redFlags.push("突发或快速加重呼吸困难/端坐呼吸，需优先评估呼吸循环急症");
  }
  const criticalBp = bp && bloodPressureIsCritical(bp) ? bp : null;
  if (criticalBp) {
    redFlags.push(criticalBp.systolic >= 180 || criticalBp.diastolic >= 120
      ? `血压 ${criticalBp.systolic}/${criticalBp.diastolic}mmHg 达重度高血压警戒值，需立即规范复测并评估急性靶器官损害；如伴胸痛、神经功能异常或呼吸困难应急诊处理`
      : `血压 ${criticalBp.systolic}/${criticalBp.diastolic}mmHg 达低血压/休克风险警戒值，需立即复测并评估循环灌注`);
  }
  if (temp != null && temp >= 40) {
    redFlags.push(`体温 ${temp}℃ 达极高热警戒值，需立即复测并评估严重感染、中枢或热相关急症`);
  }
  if (temp != null && temp < 35) {
    redFlags.push(`体温 ${temp}℃，达到低体温风险警戒阈值，需先评估循环、感染或暴露相关风险`);
  }
  if (pulse != null && (pulse >= 150 || pulse < 40)) {
    redFlags.push(`心率/脉搏 ${pulse}次/分异常，需先评估心血管风险`);
  }
  if (respiration != null && (respiration >= 35 || respiration < 8)) {
    redFlags.push(`呼吸 ${respiration}次/分异常，需先评估呼吸循环风险`);
  }
  if (spo2 != null && spo2 <= 89) {
    redFlags.push(`血氧饱和度 ${spo2}% 偏低，需先评估缺氧风险`);
  }
  // The semantic layer may add only grounded, current, emergency-level findings. Urgent/clarify
  // findings remain M02 targets and routine symptoms continue through ordinary diagnosis.
  const patientScopedFacts = state.clinicalFacts
    ? {
        ...state.clinicalFacts,
        redFlags: state.clinicalFacts.redFlags.filter((finding) => hasPatientScopedSpanOccurrence(text, finding.quote)),
      }
    : undefined;
  redFlags.push(...additiveRedFlagsFromFacts(patientScopedFacts, text, redFlags));
  return Array.from(new Set(redFlags));
}

/**
 * Model-outage fallback for common but non-definitive risk symptoms. These checks intentionally
 * never create an emergency lock: they preserve clinician visibility until the semantic model can
 * distinguish severity, timing and symptom combinations. The normal path remains fully model-owned.
 */
export function narrativeFallbackAdvisories(state: CaseState): string[] {
  // A grounded semantic finding is already visible even when the second reader timed out. Repeating
  // a keyword fallback for the same event only creates alert fatigue; retain fallback advisories for
  // genuinely empty/unavailable semantic screens.
  if (state.clinicalFacts?.semanticStatus === "checked" && state.clinicalFacts.redFlags.length > 0) return [];
  const text = trustedInputText(state);
  const advisories: string[] = [];
  if (hasAnyTerm(text, ["晕厥", "黑矇", "意识丧失"])) {
    advisories.push("晕厥、黑矇或意识丧失相关信息需优先复核当前状态、诱因、伤情及心电风险");
  }
  if (hasAnyTerm(text, ["呕血", "吐血", "黑便", "大便发黑", "粪便发黑", "排黑色便", "柏油样便", "便血"])) {
    advisories.push("消化道出血相关表现需优先复核出血量、持续性、循环状态及血红蛋白");
  }
  if (hasAnyTerm(text, ["咯血", "阴道流血", "外伤出血", "出血不止", "大量出血"])) {
    advisories.push("出血相关表现需优先复核出血量、活动性及循环状态");
  }
  if (hasAnyTerm(text, ["寒战"]) && (hasAnyTerm(text, ["高热", "发热"]) || (parseContextualTemperature(text) ?? 0) >= 38.5)) {
    advisories.push("发热伴寒战需优先复核意识、循环、感染灶及脓毒症风险");
  }
  if (hasAnyTerm(text, ["呼吸困难", "气促", "喘憋"])) {
    advisories.push("呼吸困难或气促相关表现需优先复核静息严重度、说话能力、血氧及循环状态");
  }
  if (hasAnyTerm(text, ["误服", "过量服用", "整瓶", "整盒", "中毒", "农药", "毒物"])) {
    advisories.push("可疑中毒或药物过量需立即核实物质、剂量、时间、意识及呼吸循环状态");
  }
  const glucose = text.match(/(?:血糖|GLU)\s*[:：]?\s*(\d+(?:\.\d+)?)/i)?.[1];
  if ((glucose != null && Number(glucose) < 3) || hasAnyTerm(text, ["严重低血糖", "低血糖昏迷"])) {
    advisories.push("严重低血糖或代谢异常线索需立即复测，并优先评估意识与循环状态");
  }
  if (hasAnyTerm(text, ["妊娠", "怀孕", "孕早期", "早孕"]) &&
      hasAnyTerm(text, ["腹痛", "阴道流血", "头晕", "晕厥"])) {
    advisories.push("妊娠相关腹痛、出血或循环症状需优先排除产科急症");
  }
  if (hasAnyTerm(text, ["全身冰冷", "四肢冰冷", "少尿", "无尿", "意识模糊"])) {
    advisories.push("循环灌注异常线索需立即复核血压、意识、尿量及末梢循环");
  }
  if (hasAnyTerm(text, ["风团", "荨麻疹", "脸肿", "喉紧", "喉头肿胀", "声音嘶哑"])) {
    advisories.push("严重过敏或气道受累线索需立即复核气道、呼吸和循环");
  }
  if (hasAnyTerm(text, ["发绀", "精神萎靡", "反应差"]) && hasQualitativePediatricContext(state)) {
    advisories.push("儿童全身危重表现需立即复核呼吸、循环、意识及脱水状态");
  }
  return Array.from(new Set(advisories));
}

/** Critical measured vitals are the deterministic floor of the hybrid red-flag architecture. */
export function hasDeterministicCriticalVitalRedFlag(state: CaseState): boolean {
  return detectProgrammaticRedFlags(state).some((flag) =>
    /^(?:血压(?:录入|\s)|体温\s|心率\/脉搏\s|呼吸\s|血氧饱和度\s)/.test(flag)
  );
}

/**
 * Measured values that need prompt repeat measurement and clinical review but are not, by
 * themselves, proof of an emergency. The semantic triage layer combines them with symptoms,
 * timing, baseline and target-organ findings; these advisories never become workflow blockers.
 */
export function measuredVitalAdvisories(state: CaseState): string[] {
  const text = vitalsText(state);
  const bp = parseContextualBloodPressure(text);
  const temperature = parseContextualTemperature(text);
  const pulse = parseContextualPulse(text);
  const respiration = parseContextualRespiration(text);
  const spo2 = parseContextualSpo2(text);
  const advisories: string[] = [];
  if (bp && !bloodPressureIsCritical(bp) &&
      (bp.systolic >= 180 || bp.diastolic >= 120 || bp.systolic <= 90 || bp.diastolic <= 50)) {
    advisories.push(`血压 ${bp.systolic}/${bp.diastolic}mmHg 需立即规范复测，并结合胸痛、气促、神经症状及急性靶器官损害判断处置级别`);
  }
  if (temperature != null && temperature < 40 && temperature >= 39) {
    advisories.push(`体温 ${temperature}℃ 需尽快复测，并结合寒战、意识、循环及感染灶评估`);
  } else if (temperature != null && temperature >= 35 && temperature < 36) {
    advisories.push(`体温 ${temperature}℃ 偏低，需尽快复测并结合暴露、感染和循环状态评估`);
  }
  if (pulse != null && pulse < 150 && pulse >= 120) {
    advisories.push(`心率/脉搏 ${pulse}次/分需尽快复测，并结合节律、症状及基础心率评估`);
  } else if (pulse != null && pulse >= 40 && pulse < 50) {
    advisories.push(`心率/脉搏 ${pulse}次/分需尽快复测，并结合节律、症状及基础心率评估`);
  }
  if (respiration != null && respiration < 35 && respiration >= 25) {
    advisories.push(`呼吸 ${respiration}次/分需尽快复测，并结合呼吸困难、血氧及基础状态评估`);
  }
  if (spo2 != null && spo2 > 89 && spo2 <= 91) {
    advisories.push(`血氧饱和度 ${spo2}% 需立即复测，并结合呼吸症状、基础血氧和吸氧状态评估`);
  }
  return advisories;
}

export function sectionText(markdown: string, headings: string[]): string {
  if (!markdown.trim()) return "";
  const escaped = headings.map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`^##\\s*(?:${escaped})\\s*(?:[：:]\\s*[^\\n]+)?\\s*$`, "mi");
  const match = markdown.match(pattern);
  if (!match || match.index == null) return "";
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^##\s+/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

export function detectModelRedFlags(state: CaseState): string[] {
  const redFlagTitles = sectionTitleGroup("redFlag");
  const source = [
    sectionText(state.diagnosis || "", redFlagTitles),
    sectionText(state.riskAssessment || "", redFlagTitles),
  ].filter(Boolean).join("\n");
  if (!source.trim()) return [];

  const positiveRisk = /(高风险|红旗阳性|急诊|立即转诊|建议转诊|需转诊|先转诊|需优先排除急危重|需优先排除急症|需优先排除急性|危急值)/;
  return source
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter((line) =>
      line.length > 0 &&
      positiveRisk.test(line) &&
      !(/(信息不足|缺少|缺失|补齐|补充|待补充|暂不生成|不生成|不进入方药|暂停处方|完善后|重评估)/.test(line) &&
        !/(高风险|红旗阳性|急诊|立即转诊|建议转诊|需转诊|先转诊|危急值)/.test(line)) &&
      !isRiskLineNegatedOrEnumerative(line)
    )
    .slice(0, 5);
}

function numberFromClinicalText(value: string): number | null {
  const text = normalizeClinicalText(value).trim();
  const yearMatch = text.match(/(-?\d+(?:\.\d+)?)\s*岁(?:\s*(-?\d+(?:\.\d+)?)\s*(?:个月|月龄))?/);
  if (yearMatch) {
    const years = Number(yearMatch[1]);
    const months = yearMatch[2] == null ? 0 : Number(yearMatch[2]);
    const combined = years + months / 12;
    return Number.isFinite(combined) && years >= 0 && months >= 0 && combined <= 120 ? combined : null;
  }
  const monthMatch = text.match(/(-?\d+(?:\.\d+)?)\s*(?:个月|月龄)/);
  if (monthMatch) {
    const months = Number(monthMatch[1]);
    const years = months / 12;
    return Number.isFinite(years) && months >= 0 && years <= 120 ? years : null;
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const years = Number(text);
  return Number.isFinite(years) && years >= 0 && years <= 120 ? years : null;
}

function hasInvalidAgeText(value: string): boolean {
  const text = normalizeClinicalText(value).trim();
  if (!/-?\d+(?:\.\d+)?/.test(text)) return false;
  return numberFromClinicalText(text) == null;
}

function patientSexText(state: CaseState): string {
  const structured = authoritativeFieldOrFallback(state, "sex", state.patient.sex);
  if (isKnownClinicalText(structured)) {
    const normalized = normalizeClinicalText(structured).trim();
    if (/女/.test(normalized) || /^(?:f|female|woman)$/i.test(normalized)) return "女";
    if (/男/.test(normalized) || /^(?:m|male|man)$/i.test(normalized)) return "男";
  }
  const text = normalizeClinicalText(trustedInputText(state));
  const explicitMale = /(?:^|[，,；;。\s])(?:患者|病人)?\s*(?:男性|男)(?=[，,；;。\s\d]|性|患者|童)/.test(text) || /\d{1,3}\s*岁\s*(?:男性|男|男童)/.test(text) || /\b(?:male|man)\b/i.test(text) || /(?:性别|sex)\s*[:：]?\s*m\b/i.test(text);
  const explicitFemale = /(?:^|[，,；;。\s])(?:患者|病人)?\s*(?:女性|女)(?=[，,；;。\s\d]|性|患者)/.test(text) || /\d{1,3}\s*岁\s*(?:女性|女)/.test(text) || /\b(?:female|woman)\b/i.test(text) || /(?:性别|sex)\s*[:：]?\s*f\b/i.test(text);
  if (explicitMale && !explicitFemale) return "男";
  if (explicitFemale && !explicitMale) return "女";
  // 妊娠/孕周/哺乳可在缺少性别字段时作为女性生理状态线索；“备孕”可能描述男性，不能单独推断女性。
  if (/(妊娠|孕\d+周|哺乳期)/.test(text)) return "女";
  return "";
}

function patientAgeText(state: CaseState): string {
  const structured = authoritativeFieldOrFallback(state, "age", state.patient.age != null ? String(state.patient.age) : "");
  if (isKnownClinicalText(structured)) return structured;
  const text = normalizeClinicalText(trustedInputText(state));
  const ageLiteral = String.raw`(-?\d{1,4}(?:\.\d+)?\s*(?:岁(?:\s*\d{1,4}(?:\.\d+)?\s*(?:个月|月龄))?|个月|月龄))`;
  const labeled = text.match(new RegExp(`(?:^|[。；;\\n])\\s*(?:(?:患者|病人)\\s*)?年龄\\s*[:：]?\\s*${ageLiteral}`));
  if (labeled?.[1]) return labeled[1];
  const subjectFirst = text.match(new RegExp(
    `(?:^|[。；;\\n])\\s*(?:(?:患者|病人)\\s*(?:为|系|是)?\\s*(?:一名|一位)?\\s*(?:男性|女性|男|女|男童|女童|患儿)?|患儿|男童|女童|男性|女性|男|女)\\s*(?:年龄\\s*[:：]?|为|系|是|约|，|,)?\\s*${ageLiteral}`,
  ));
  if (subjectFirst?.[1]) return subjectFirst[1];
  const ageFirst = text.match(new RegExp(
    `(?:^|[。；;\\n])\\s*(?:主诉|现病史)?\\s*[:：]?\\s*${ageLiteral}\\s*(?=男性|女性|男|女|男童|女童|患儿|患者|病人|[，,]\\s*(?:因|主诉|就诊|反复|出现|有|无|患))`,
  ));
  if (ageFirst?.[1]) return ageFirst[1];
  const conciseAgeFirst = text.match(new RegExp(
    `(?:^|[。；;\\n])\\s*(?:主诉|现病史)?\\s*[:：]?\\s*${ageLiteral}\\s*(?=(?:因|反复|出现|主诉|就诊|诉|患))`,
  ));
  return conciseAgeFirst?.[1] || "";
}

/** Structured patient age shared by downstream regimen rendering; avoids reparsing prose context. */
export function authoritativePatientAgeYears(state: CaseState): number | undefined {
  return numberFromClinicalText(patientAgeText(state)) ?? undefined;
}

function pregnancyScreenRequired(state: CaseState): boolean {
  const sex = patientSexText(state);
  if (!/女/.test(sex)) return false;
  const text = normalizeClinicalText(trustedInputText(state));
  const physiologicallyNotAtRisk = /(绝经|停经)\s*(?:已|约)?\s*(?:1[2-9]|[2-9]\d)\s*(?:个月|月)|绝经后|双侧卵巢切除|子宫全切(?:除)?|无子宫/.test(text);
  // Age alone cannot establish reproductive potential. Without explicit physiologic status, screen
  // every female patient fail-closed, including adolescents and older adults whose menopause is unknown.
  return !physiologicallyNotAtRisk;
}

function hasNumericPediatricWeight(text: string): boolean {
  // Must be an explicit body-weight value (体重/WT/weight/BW immediately followed by the number).
  // A bare "<n>kg" elsewhere (e.g. "体重下降5kg" weight loss) must NOT satisfy the weight requirement.
  return /(?:体重|体重约|BW|WT|weight)\s*[:：约为]?\s*\d{1,3}(?:\.\d+)?\s*(?:kg|公斤|千克)?/i.test(normalizeClinicalText(text));
}

// 儿科病例可能只用定性词标注(患儿/婴儿/男童/月龄…)而无数字年龄。这类同样必须命中儿童剂量门：
// 本地知识库只有成人剂量区间，任何候选方一律 fail-closed 到儿科医师/药师个体化复核，绝不退化为成人剂量。
function hasQualitativePediatricContext(state: CaseState): boolean {
  const structuredDemographics = normalizeClinicalText([
    state.hisRecord?.fields?.sex,
    state.hisRecord?.fields?.age,
    state.patient.sex,
  ].filter(Boolean).join("；"));
  if (/(患儿|儿童|未成年人|新生儿|婴儿|婴幼儿|乳儿|幼儿|宝宝|男童|女童|月龄)/.test(structuredDemographics)) {
    return true;
  }
  return normalizeClinicalText(trustedInputText(state))
    .split(/[。；;\n]+/)
    .map((clause) => clause.trim().replace(/^(?:主诉|现病史|患者信息|一般资料)\s*[:：]\s*/, ""))
    .some((clause) => /^(?:(?:患者|病人)\s*(?:为|系|是)?\s*)?(?:一名|一位|该名|这个)?\s*(?:患儿|儿童患者|儿童|未成年人|新生儿|婴儿|婴幼儿|乳儿|幼儿|宝宝|小孩|孩子|少年|学龄前儿童|小学生|中学生|男童|女童)/.test(clause));
}

function hasExplicitPregnancyStatus(text: string): boolean {
  return isKnownClinicalState(assessPregnancyState(text));
}

function hasExplicitLactationStatus(text: string): boolean {
  return isKnownClinicalState(assessLactationState(text));
}

function hasExplicitConceptionStatus(text: string): boolean {
  return isKnownClinicalState(assessConceptionState(text));
}

function hasPositivePregnancyOrLactationRisk(text: string): boolean {
  return [
    assessPregnancyState(text),
    assessLactationState(text),
    assessConceptionState(text),
  ].some(isPositiveOrPossibleClinicalState);
}

function missingVitalsForHighRiskPresentation(state: CaseState): string[] {
  const text = structuredCaseText(state);
  const hasRespiratoryRisk = hasAnyTerm(text, ["呼吸困难", "气促", "喘憋", "端坐呼吸"]);
  const hasAcuteAbdominalRisk = hasAcuteAbdominalSignal(text);
  const hasBleedingRisk = hasAnyTerm(text, ["呕血", "吐血", "黑便", "大便发黑", "粪便发黑", "排黑色便", "柏油样便", "便血", "咯血", "阴道流血", "外伤出血", "出血不止", "大量出血"]);
  const hasOtherHighRiskPresentation =
    hasAnyTerm(text, ["胸痛", "胸闷", "心前区痛", "晕厥", "黑矇", "意识丧失", "寒战", "高热", "意识改变", "言语不清", "肢体无力"]) ||
    hasBleedingRisk ||
    hasAcuteAbdominalRisk ||
    hasPatternWithoutNegation(text, /(突发|剧烈).{0,8}头痛|发热.{0,8}寒战|寒战.{0,8}发热/);
  if (!hasRespiratoryRisk && !hasOtherHighRiskPresentation) return [];

  const vital = vitalsText(state);
  const missing: string[] = [];
  if (parseTemperature(vital) == null) missing.push("体温");
  if (parsePulse(vital) == null) missing.push("心率/脉搏");
  if (parseRespiration(vital) == null) missing.push("呼吸");
  if (parseBloodPressure(vital) == null) missing.push("血压");
  if (hasRespiratoryRisk && parseSpo2(vital) == null) missing.push("血氧饱和度");
  return missing;
}

function medicationStatusIsActionable(text: string): boolean {
  if (!isKnownClinicalText(text)) return false;
  if (
    /(否认|无|没有|未使用|未服用)[^。；\n]{0,24}(用药|服药|当前用药|长期用药|中药|中成药|西药|保健品)/.test(text) ||
    /(目前|当前)?[^。；\n]{0,8}(未|无|没有)[^。；\n]{0,16}(使用|服用)[^。；\n]{0,18}(中药|中成药|西药|保健品|药物)/.test(text) ||
    /(?:已|现已)?停用[^。；\n]{0,12}(?:全部|所有)?(?:药物|中药|中成药|西药|保健品)/.test(text)
  ) return true;
  const namedDose = /(?:服用|口服|使用|应用|在用|现服|偶服|吃)[^。；\n]{0,10}([\u4e00-\u9fa5A-Za-z]{2,20})\s*\d+(?:\.\d+)?\s*(?:mg|g|ml|毫克|克|片|粒|袋|丸)/i.exec(text) ||
    /(?:^|[，,；;。\n])\s*((?:阿司匹林|华法林|二甲双胍|胰岛素|硝苯地平|缬沙坦|氯吡格雷|褪黑素)|[\u4e00-\u9fa5A-Za-z]{2,20}(?:片|胶囊|颗粒|丸|散|口服液|注射液))\s*\d+(?:\.\d+)?\s*(?:mg|g|ml|毫克|克|片|粒|袋|丸)/i.exec(text);
  if (!namedDose || /^(?:药物|中药|西药|成药|安眠药|降压药|降糖药|抗凝药|止痛药|止咳药)$/.test(namedDose[1])) return false;
  return /(?:每(?:日|天|晚|早|周)|一日|一天|早晚|睡前|晨起|餐前|餐后|必要时|按需|偶尔|不定期|\b(?:bid|tid|qd|qod|prn)\b|\d+\s*次\s*[\/／]\s*(?:日|天|周))/i.test(text);
}

function allergyStatusIsActionable(text: string): boolean {
  if (!isKnownClinicalText(text)) return false;
  if (/(否认|无|没有)[^。；\n]{0,12}(过敏|药物过敏|食物过敏)/.test(text)) return true;
  return /(青霉素|头孢|磺胺|阿司匹林|布洛芬|花粉|海鲜|皮疹|喉头水肿|呼吸困难|过敏性休克|荨麻疹)/.test(text);
}

function allergyHistoryNeedsClarification(text: string): boolean {
  const normalized = stringifyClinicalValue(text).trim();
  if (!normalized) return false;
  if (allergyStatusIsActionable(text)) return false;
  if (/^(?:过敏史|药物过敏|食物过敏)?[:：]?(?:未提及|未采集|未知|不详|待确认|需确认)$/.test(normalized)) {
    return false;
  }
  return /(有|曾|既往|出现过|发生过)[^。；\n]{0,18}(过敏|药物过敏|食物过敏)|过敏体质|易过敏|过敏待查|过敏[^。；\n]{0,18}(不详|不清楚|不明确|待查)|药物过敏史[^。；\n]{0,18}(不详|不清楚|不明确|待查)/.test(normalized);
}

function medicationHistoryNeedsClarification(text: string): boolean {
  const normalized = stringifyClinicalValue(text).trim();
  if (!normalized) return false;
  if (medicationStatusIsActionable(text)) return false;
  if (/^(?:用药史|当前用药|现用药)?[:：]?(?:未提及|未采集|未知|不详|待确认|需确认)$/.test(normalized)) {
    return false;
  }
  return /(服用|口服|使用|注射|应用|在用|现服|偶服|吃)|(?:阿司匹林|华法林|二甲双胍|胰岛素|硝苯地平|缬沙坦|氯吡格雷|褪黑素)|\d+(?:\.\d+)?\s*(?:mg|g|ml|毫克|克|片|粒|袋|丸)/i.test(normalized) ||
    /(正在|长期|目前|当前|平时|一直|近期)?[^。；\n]{0,12}(服用|口服|使用|注射|应用|在用)[^。；\n]{0,18}(药|中药|中成药|西药|保健品|降压药|降糖药|抗凝药|止痛药|安眠药)/.test(normalized) ||
    /(降压药|降糖药|抗凝药|抗血小板药|止痛药|止咳药|安眠药|中成药|中药|西药|保健品)[^。；\n]{0,30}(不详|不清(?:楚)?|忘记|未带|不明确|若干|一些|长期)/.test(normalized) ||
    /(服用|口服|使用|在用)[^。；\n]{0,24}(药|降压药|降糖药|抗凝药|中成药|西药)[^。；\n]{0,30}(药名|剂量|频次)[^。；\n]{0,18}(不详|不清(?:楚)?|不明确|未知)/.test(normalized);
}

function extractMedicationEvidenceText(text: string): string {
  return text
    .split(/[。；;\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => {
      const allergyOnly = /(过敏|不良反应|ADR)/i.test(clause) &&
        !/(当前用药|现用药|用药史|服药|服用|口服|注射|应用|在用|停药|换药|减药|药名|剂量|频次)/.test(clause);
      if (allergyOnly) return false;
      return /(用药|服药|服用|口服|注射|应用|在用|停药|换药|减药|药名|剂量|频次|降压药|降糖药|抗凝药|抗血小板药|止痛药|止咳药|安眠药|中成药|中药|西药|保健品|阿司匹林|华法林|二甲双胍|胰岛素|硝苯地平|缬沙坦|氯吡格雷|[\u4e00-\u9fa5A-Za-z]{2,}(?:片|胶囊|颗粒|丸|散|口服液|注射液)|\d+(?:\.\d+)?\s*(?:mg|g|ml)\b|\b(?:bid|tid|qd|qod)\b)/i.test(clause);
    })
    .join("；");
}

function extractAllergyEvidenceText(text: string): string {
  return text
    .split(/[。；;\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => /(过敏|不良反应|ADR|青霉素|头孢|磺胺|花粉|海鲜|荨麻疹|喉头水肿|过敏性休克)/i.test(clause))
    .join("；");
}

// A missing chief complaint is the only missing-data hard stop. Every other missing field is a
// high-information follow-up opportunity: the doctor may answer it or explicitly continue with a
// visibly limited candidate. Positive pediatric/pregnancy states and true emergencies are handled
// separately as actual dose boundaries, not confused with an unknown field.
const FORMAL_ADOPTION_BLOCKING_CODES: ReadonlySet<SafetyMissingItemCode> = new Set(["chief_complaint"]);

function semanticScreeningUnavailableItem(state: CaseState): string | undefined {
  if (state.clinicalFacts?.sourceCoverage === "partial") {
    return "病历超出语义红旗预检完整覆盖范围";
  }
  if (state.clinicalFacts?.semanticStatus === "checked" && state.clinicalFacts.reviewStatus !== "checked") {
    return "语义红旗独立复核未完成";
  }
  if (state.clinicalFacts?.semanticStatus !== "unavailable") return undefined;
  const reasonLabels = {
    disabled: "语义模型已禁用",
    aborted: "请求中止",
    timeout: "模型超时",
    model_error: "模型调用失败",
    invalid_output: "模型输出无效",
    signing_unavailable: "可信签名不可用",
  } as const;
  const reason = state.clinicalFacts.unavailableReason;
  return `语义红旗筛查未完成${reason ? `（${reasonLabels[reason]}）` : ""}`;
}

export function canForceProceedPastSafetyGate(gate: SafetyGate | undefined): boolean {
  if (!gate) return false;
  if (gate.status === "red_flag") return false;
  if (gate.status === "ready") return true;
  if (gate.missingItemCodes && gate.missingItemCodes.length === gate.missingItems.length) {
    return gate.missingItemCodes.length > 0 && gate.missingItemCodes.every((code) => !FORMAL_ADOPTION_BLOCKING_CODES.has(code));
  }
  // Compatibility for drafts persisted before typed missing-item codes were introduced.
  return gate.missingItems.length > 0 && gate.missingItems.every((item) => item !== "主诉");
}

export function hardDoseSafetyBoundaryReasons(state: CaseState): string[] {
  const gate = evaluateSafetyGate(state);
  if (gate.status === "red_flag") return gate.redFlags.length > 0 ? gate.redFlags : ["命中急危重红旗"];
  const text = structuredCaseText(state);
  const age = numberFromClinicalText(patientAgeText(state));
  const reasons: string[] = [];
  if ((age != null && age < 18) || (age == null && hasQualitativePediatricContext(state))) {
    reasons.push("儿童病例当前未配置可验证的个体化剂量规则");
  }
  if (hasPositivePregnancyOrLactationRisk(text)) {
    reasons.push("已记录妊娠、哺乳或备孕阳性/可疑状态");
  }
  return reasons;
}

export function hasHardDoseSafetyBoundary(state: CaseState): boolean {
  return hardDoseSafetyBoundaryReasons(state).length > 0;
}

export type PrescriptionPermission = {
  candidateMode: "full_dose" | "limited_dose" | "non_dose_only" | "blocked";
  formalAdoption: "eligible_after_doctor_confirmation" | "blocked";
  reasons: string[];
};

/**
 * Candidate generation and formal adoption are separate permissions. Clinical alerts and audit
 * outcomes remain visible, but they cannot silently change either permission. This is the single
 * authority consumed by M04, the workbench and the HIS integration payload.
 */
export function derivePrescriptionPermission(state: CaseState): PrescriptionPermission {
  const gate = evaluateSafetyGate(state);
  const chiefComplaint = (state.chiefComplaint || fieldText(state, "zhushu")).trim();
  if (!chiefComplaint) {
    return { candidateMode: "blocked", formalAdoption: "blocked", reasons: ["缺少主诉"] };
  }
  if (gate.status === "red_flag") {
    return {
      candidateMode: "non_dose_only",
      formalAdoption: "blocked",
      reasons: gate.redFlags && gate.redFlags.length > 0
        ? [...gate.redFlags]
        : ["当前存在急危重分流提示"],
    };
  }

  const text = structuredCaseText(state);
  const age = numberFromClinicalText(patientAgeText(state));
  const pediatric = (age != null && age < 18) || (age == null && hasQualitativePediatricContext(state));
  const positivePregnancyOrLactation = hasPositivePregnancyOrLactationRisk(text);
  const nonDoseReasons = [
    pediatric ? "儿童病例当前未配置可验证的个体化剂量规则" : "",
    positivePregnancyOrLactation ? "已记录妊娠、哺乳或备孕阳性/可疑状态" : "",
  ].filter(Boolean);
  if (nonDoseReasons.length > 0) {
    return { candidateMode: "non_dose_only", formalAdoption: "blocked", reasons: nonDoseReasons };
  }

  const semanticSafetyUnverified = gate.missingItemCodes?.includes("semantic_screen_unavailable") === true;
  if (semanticSafetyUnverified) {
    return {
      candidateMode: "non_dose_only",
      formalAdoption: "blocked",
      reasons: Array.from(new Set([
        "语义红旗筛查或独立复核未完成，当前仅生成非剂量临床分析",
        ...(gate.missingItems || []),
      ])),
    };
  }

  if (gate.status === "needs_information" || gate.missingItems.length > 0) {
    return {
      candidateMode: "limited_dose",
      formalAdoption: "eligible_after_doctor_confirmation",
      reasons: Array.from(new Set([...(gate.missingItems || []), ...(gate.advisories || [])])),
    };
  }
  return {
    candidateMode: "full_dose",
    formalAdoption: "eligible_after_doctor_confirmation",
    reasons: gate.advisories || [],
  };
}

export function evaluateSafetyGate(state: CaseState): SafetyGate {
  const missingItems: string[] = [];
  const missingItemCodes: SafetyMissingItemCode[] = [];
  const addMissing = (code: SafetyMissingItemCode, label: string) => {
    missingItemCodes.push(code);
    missingItems.push(label);
  };
  const reasons: string[] = [];
  const vitalAdvisories = measuredVitalAdvisories(state);
  const semanticAdvisories = semanticTriageAdvisoriesFromFacts(state.clinicalFacts, trustedInputText(state));
  const priorityEvaluationItems = priorityEvaluationItemsFromFacts(state.clinicalFacts, trustedInputText(state));
  const fallbackAdvisories = narrativeFallbackAdvisories(state);
  const advisories = Array.from(new Set([...semanticAdvisories, ...fallbackAdvisories, ...vitalAdvisories]));
  const text = structuredCaseText(state);
  const ageRaw = patientAgeText(state);
  const age = numberFromClinicalText(ageRaw);
  const ageWasEntered = isKnownClinicalText(ageRaw);
  const hasInvalidAge = ageWasEntered && age == null && hasInvalidAgeText(ageRaw);
  const topLevelAge = normalizedAgeLiteral(state.patient.age);
  const hisAge = normalizedAgeLiteral(state.hisRecord?.fields?.age);
  const hasAgeConflict = Boolean(topLevelAge && hisAge && topLevelAge !== hisAge);
  const structuredBloodPressure = structuredBloodPressureAssessment(state);
  const hasInvalidBp = hasInvalidBloodPressureOrder(vitalsText(state)) ||
    (structuredBloodPressure.status === "invalid" && structuredBloodPressure.reason === "order");

  if (!isKnownClinicalText(state.chiefComplaint || fieldText(state, "zhushu"))) addMissing("chief_complaint", "主诉");
  if (hasInvalidAge) addMissing("age_invalid", "年龄数值需复核（0-120岁）");
  if (hasAgeConflict) addMissing("age_conflict", "年龄记录冲突需复核");
  const trustedText = trustedInputText(state);
  const sex = patientSexText(state);
  const allergyText = authoritativeFieldOrFallback(state, "guomin", state.allergyHistory) || extractAllergyEvidenceText(trustedText);
  const medicationText =
    authoritativeFieldOrFallback(state, "yongyaoshi", state.medicationHistory) ||
    extractMedicationEvidenceText(trustedText);
  if (!isKnownClinicalText(sex)) addMissing("sex_unknown", "性别/生理状态");
  if (!isKnownClinicalText(allergyText)) addMissing("allergy_unknown", "过敏史（明确有/无及过敏原/反应）");
  else if (allergyHistoryNeedsClarification(allergyText)) addMissing("allergy_details", "已提及过敏史但缺少过敏原/反应");
  if (!isKnownClinicalText(medicationText)) addMissing("medication_unknown", "当前用药（明确有/无及药物清单）");
  else if (medicationHistoryNeedsClarification(medicationText)) addMissing("medication_details", "已提及当前用药但缺少药名/剂量/频次");
  if (hasInvalidBp) addMissing("blood_pressure_invalid", "血压数值需复核（收缩压应高于舒张压）");
  const invalidVitalFindings = invalidEnteredVitalFindings(state).filter((finding) => !(finding.name === "血压" && hasInvalidBp));
  if (invalidVitalFindings.length > 0) {
    addMissing("vitals_invalid", `生命体征数值需复核（${invalidVitalFindings.map(formatInvalidVitalFinding).join("；")}）`);
  }
  const vitalSourceConflicts = Array.isArray(state.vitals?.sourceConflicts)
    ? state.vitals.sourceConflicts.map((item) => stringifyClinicalValue(item)).filter(Boolean)
    : [];
  if (vitalSourceConflicts.length > 0) {
    const conflictSummary = vitalSourceConflicts.join("；").slice(0, 600);
    addMissing("vitals_source_conflict", `生命体征来源记录冲突（${conflictSummary}）`);
    advisories.push(`生命体征存在来源冲突，请以本次实测值核对后更新：${conflictSummary}`);
  }
  const semanticUnavailable = semanticScreeningUnavailableItem(state);
  if (semanticUnavailable) addMissing("semantic_screen_unavailable", semanticUnavailable);
  if (priorityEvaluationItems.length > 0) {
    addMissing("priority_evaluation_required", `正式采纳前需优先完成临床评估（${priorityEvaluationItems.join("；")}）`);
  }
  const highRiskMissingVitals = missingVitalsForHighRiskPresentation(state);
  if (highRiskMissingVitals.length > 0) {
    addMissing("high_risk_missing_vitals", `高风险主诉需补充生命体征（${highRiskMissingVitals.join("、")}）`);
  }
  const authoritativeTongue = authoritativeFieldOrFallback(state, "tcmTongue", state.tongue);
  const visionTongue = state.hisRecord?.tongueImageUploaded ? state.tongueImageDesc : undefined;
  if (!isKnownTongueClinicalText(authoritativeTongue || visionTongue)) addMissing("tongue_unknown", "舌象");
  if (!isKnownPulseClinicalText(authoritativeFieldOrFallback(state, "tcmPulse", state.pulse))) addMissing("pulse_unknown", "脉象");
  if ((age != null && age < 18) || (age == null && hasQualitativePediatricContext(state))) {
    if (!hasNumericPediatricWeight(text)) addMissing("pediatric_weight_unknown", "儿童体重数值");
    // The current deterministic knowledge base has adult per-herb ranges only. Recording weight is
    // necessary clinical context but cannot be treated as a pediatric dose algorithm.
    addMissing("pediatric_dose_rules_unavailable", "未配置儿童剂量级处方规则（需儿科中医师/药师个体化复核）");
  }
  if (pregnancyScreenRequired(state)) {
    if (!hasExplicitPregnancyStatus(text)) addMissing("pregnancy_unknown", "妊娠状态");
    if (!hasExplicitLactationStatus(text)) addMissing("lactation_unknown", "哺乳状态");
    if (!hasExplicitConceptionStatus(text)) addMissing("conception_unknown", "备孕状态");
  }
  if (mentalHealthSafetyScreenRequired(trustedText) &&
      !hasExplicitMentalHealthSafetyScreen(trustedText) &&
      !hasCurrentMentalHealthCrisis(trustedText)) {
    addMissing("behavioral_crisis_screening", "情志危机需补充当前自杀/自伤/他伤安全筛查");
  }
  if (insomniaPresentation(trustedText) && !hasExplicitOsaScreen(trustedText)) {
    addMissing("osa_screening", "失眠需补充OSA风险筛查（打鼾/呼吸暂停/日间嗜睡/高血压）");
  }
  if (thyroidScreenRequired(trustedText) && !hasCurrentThyroidAssessment(trustedText)) {
    addMissing("thyroid_screening", "相关症状需补充甲状腺功能线索或近期甲功");
  }

  // Hard-stop red flags must be traceable to the current authoritative record. Model report text is
  // intentionally excluded here: a previous limited template or an ungrounded M01 extraction must not
  // feed itself back into the next safety evaluation and permanently lock the case.
  const redFlags = detectProgrammaticRedFlags(state);
  if (redFlags.length > 0) {
    return {
      status: "red_flag",
      // 急性红旗不终止 Agent 会话：允许 M03 继续生成风险分析、鉴别与转诊闭环；
      // 但剂量级 M04 与正式采纳保持硬边界。
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: "refer_or_emergency",
      missingItems,
      missingItemCodes,
      redFlags,
      advisories,
      reasons: ["命中程序化红旗指征，需先完成急危重症排查或转诊评估。"],
    };
  }

  const diagnosisBlockingMissing = missingItems.filter((item) => item === "主诉");

  // 没有主诉就没有可分析的临床目标。其余缺口先进入追问，但不再阻断医生显式选择的
  // 有限分析；最终候选会携带安全锁，正式采纳仍需补齐。
  if (diagnosisBlockingMissing.length > 0) {
    reasons.push(...vitalAdvisories);
    reasons.push(`缺少临床分析入口（${diagnosisBlockingMissing.join("、")}），请先补充后再进行辨证。`);
    return {
      status: "needs_information",
      allowDiagnosis: false,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems,
      missingItemCodes,
      redFlags: [],
      advisories,
      reasons,
    };
  }

  // 有主诉即可在追问后继续 M03。舌脉、常规筛查和处方级安全槽位不足时，默认先追问；
  // 医生显式继续可查看安全锁定候选，儿科/急性高危/明确孕哺等硬边界仍不能绕过。
  // An explicit positive pregnancy/lactation/conception statement is itself sufficient to lock the
  // dose path, even if a stale or contradictory demographic field says male/outside childbearing age.
  const pregnancyPositive = hasPositivePregnancyOrLactationRisk(text);
  if (missingItems.length > 0 || pregnancyPositive) {
    const prescriptionMissing = pregnancyPositive
      ? [...missingItems, "特殊人群用药复核（妊娠/哺乳/备孕阳性）"]
      : missingItems;
    reasons.push(...vitalAdvisories, `辨证信息已具备；剂量级候选处方前需补齐或复核：${prescriptionMissing.join("、")}。`);
    return {
      status: "needs_information",
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems: prescriptionMissing,
      missingItemCodes,
      redFlags: [],
      advisories,
      reasons,
    };
  }

  return {
    status: "ready",
    allowDiagnosis: true,
    allowDosePrescription: true,
    action: "proceed",
    missingItems: [],
    missingItemCodes: [],
    redFlags: [],
    advisories,
    reasons: [...vitalAdvisories, "主诉、舌脉和核心辨证信息已具备，可进入辅助推理。"],
  };
}

export function withSafetyGate(state: CaseState): CaseState {
  const operationalCompleteness = deriveOperationalCompleteness(state);
  // Completeness is a live property of the current record. Never keep a historical/model high score
  // after the clinician clears a field or changes it to "待核实"; doing so lets stale confidence unlock
  // M03/M04. Model analysis remains visible in its report, while the workflow gate is recomputed solely
  // from the current authoritative record on every transition and restore.
  const next = {
    ...state,
    completeness: operationalCompleteness,
  };
  return { ...next, safetyGate: evaluateSafetyGate(next) };
}

export function reconcileRestoredCaseState(state: CaseState): CaseState {
  const recomputed = withSafetyGate(state);
  if (recomputed.safetyGate?.allowDiagnosis === false) {
    return {
      ...recomputed,
      phase: state.lastError ? "error" : "question",
      diagnosis: undefined,
      prescription: undefined,
      riskAssessment: undefined,
      reasoningDiagnose: undefined,
      reasoningPrescribe: undefined,
      reasoningV2: undefined,
      prescriptionRevision: undefined,
      safetyLocked: true,
      lastError: state.lastError,
    };
  }
  if (recomputed.safetyGate?.allowDosePrescription === false) {
    return {
      ...recomputed,
      // Preserve the last generated result for clinical review, but relock it under the current
      // safety rules. A refresh or rule upgrade must not silently delete work or upgrade it to an
      // adoptable prescription.
      safetyLocked: true,
      // A failed M03/M04/M05 must remain retryable after refresh. Clearing lastError here used to
      // convert a real stage failure into a dead "待生成" report with no recovery action.
      lastError: state.lastError,
    };
  }
  // A previously limited/truncated/unverified result does not become adoptable merely because a
  // later restore happens to see a ready gate. Only a fresh successful generation/audit may clear
  // that provenance lock.
  return { ...recomputed, safetyLocked: state.safetyLocked === true };
}

export function deriveSafetyLocked(
  state: CaseState,
  opts: {
    truncated?: boolean;
    placeholderSource?: boolean;
    contentMismatch?: boolean;
    hardSafetyLock?: boolean;
  } = {},
): boolean {
  const gate = state.safetyGate || evaluateSafetyGate(state);
  const permission = derivePrescriptionPermission({ ...state, safetyGate: gate });
  return Boolean(
    !gate.allowDiagnosis ||
    permission.formalAdoption === "blocked" ||
    opts.truncated ||
    opts.placeholderSource ||
    opts.contentMismatch ||
    opts.hardSafetyLock,
  );
}

export function buildSafetyLimitedDiagnosis(state: CaseState, gate: SafetyGate): string {
  const status = gate.status === "red_flag" ? "高风险安全建议模式" : "信息不足建议模式";
  const redFlagRows = gate.redFlags.length > 0
    ? gate.redFlags.map((item) => `| 急危重红旗 | 高风险 | ${item} | 先急诊/转诊或完成专科排查；补充评估结果后可重新推理 |`)
    : ["| 急危重红旗 | 信息不足/待复核 | 未见确定性程序化红旗；仍需按病情补齐关键安全信息 | 补齐缺失槽位后重新评估 |"];
  const missingRows = gate.missingItems.length > 0
    ? gate.missingItems.map((item) => `| ${item} | 影响红旗排查/辨证或处方安全 | 左侧病历字段或底部补充框补录后重新提交 |`)
    : ["| 无确定缺失项 | 仍需医生现场查体、生命体征和必要检查复核 | 如病情变化，补充后重新提交 |"];
  return [
    "## CDSS输出层级",
    `**结论**：${status}`,
    `**理由**：${gate.reasons.join("；")}`,
    `**缺失信息**：${gate.missingItems.length > 0 ? gate.missingItems.join("、") : "无"}`,
    `**处理建议**：${gate.status === "red_flag" ? "立即停止常规诊疗并转急诊；危及生命时呼叫120。先完成急诊/转诊评估或补充检查；若医生已排除急症，可在左侧补充排查结果后重新推理。" : "请完善关键病历与安全槽位后再进行辨证和处方建议。"}`,
    "",
    "## 红旗排查",
    "| 风险类别 | 风险评估 | 患者依据 | 下一步 |",
    "|---------|---------|---------|-------|",
    ...redFlagRows,
    "",
    "## 信息充分度",
    "| 补录项 | 影响环节 | 建议动作 |",
    "|-------|---------|---------|",
    ...missingRows,
    "",
    "## 西医诊断",
    "| 项目 | 内容 |",
    "|------|------|",
    `| 西医诊断 | ${gate.status === "red_flag" ? "急危重症风险线索待排除，需优先转诊或急诊评估" : "信息不足，暂不生成西医诊断倾向"} |`,
    `| 支持证据 | ${gate.redFlags.join("；") || gate.reasons.join("；")} |`,
    "| 建议检查 | 由医生结合主诉和现场情况补充生命体征、必要检验检查及专科评估 |",
    "| 证据依据 | 程序化红旗与安全槽位门控；具体医学依据需结合院内规则和指南复核 |",
    "",
    "## 中医证候诊断",
    "**证候诊断**：暂不生成",
    "**证候-病机关联**：信息不足，需补齐主诉、舌象、脉象或处方级安全信息后再进行处方级建议。年龄和非高风险场景下的生命体征不作为通用必填项；性别/生理状态、过敏史、当前用药以及儿童、妊娠哺乳等特殊人群信息必须在剂量级候选方药前明确。",
    "**证据支持**：当前资料不足以形成可采纳的证候-病机链路。",
    "**证据依据**：程序化安全门控；具体医学依据需结合院内规范、指南/文献/说明书检索和医生现场评估复核。",
    "",
    "## 证候分布与病机映射",
    "| 候选证候 | 主/兼 | 关联病机 | 治法方向 | 支持证据 | 反证/冲突点 | 置信度 | 下一步 |",
    "|---------|------|---------|---------|---------|------------|-------|-------|",
    "| 暂不生成 | - | 信息不足或安全门控未满足 | 暂不进入方药 | 当前缺少关键补录项或存在红旗排查需求 | 无法形成闭环证据链 | 低 | 补齐后重新推理 |",
    "",
    "## 总体病机",
    "**病位**：暂不判断",
    "**病性**：暂不判断",
    "**核心病机**：暂不生成；需补齐安全门控与四诊证据后再判断。",
    "**病机依据**：当前输出只用于补录与安全提示，不作为处方级辨证依据。",
    "",
    "## 治法框架",
    "**总治法**：暂不生成",
    "**子治法组合**：待红旗排查与四诊信息补齐后生成。",
    "",
    "## 证据链",
    "| 结论 | 支持证据 | 反证/限制 | 缺失信息 | 来源依据 | 置信度 | 下一步 |",
    "|------|---------|-----------|---------|---------|-------|-------|",
    `| ${status} | ${gate.redFlags.join("；") || gate.reasons.join("；")} | 不形成正式诊断或处方 | ${gate.missingItems.join("、") || "医生现场评估结果"} | 程序化安全门控 | 中 | 补齐后重新评估 |`,
  ].join("\n");
}

/**
 * A hard red flag or an exhausted M03 repair must close as an explicit, signed limited contract,
 * not as a half-JSON stream. This contract intentionally leaves TCM syndrome/pathogenesis
 * unresolved: it authorizes only the next non-dose safety step and cannot become a dose-level M04.
 */
export function buildSafetyLimitedDiagnosisReasoning(
  state: CaseState,
  gate: SafetyGate,
): ClinicalReasoningResultV2 {
  const redFlag = gate.status === "red_flag";
  const evidence = {
    evidenceLevel: "deterministic_rule" as const,
    source: redFlag ? "服务端急危重安全门禁" : "服务端M03有限结果门禁",
    confidence: redFlag ? "高" as const : "低" as const,
  };
  const supportingFacts = redFlag
    ? gate.redFlags.slice(0, 8)
    : [state.chiefComplaint || state.hisRecord?.fields?.zhushu || "当前主诉已记录"].filter(Boolean).slice(0, 8);
  const uncertaintyItems = (gate.missingItems.length > 0
    ? gate.missingItems
    : [redFlag ? "急症现场评估结果" : "稳定的证候与病机链"])
    .slice(0, 12)
    .map((item) => ({
      item,
      reason: redFlag ? "当前应优先完成急诊或专科评估" : "当前资料或模型结果不足以形成稳定结论",
      affects: "中医证候、病机与剂量级候选方药",
    }));

  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    completeness: state.completeness,
    overview: {
      primarySyndrome: redFlag ? "急症处置优先，中医证候暂缓" : "暂未形成稳定证候锚点",
      primarySyndromeResolution: "unresolved",
      primarySyndromeBasis: [],
      primarySyndromeResolutionReason: redFlag
        ? "已命中急危重安全门禁，不应因追求中医证候闭环而延误急诊处置"
        : "M03未形成通过临床与结构复核的稳定证候结果",
      secondarySyndromes: [],
      overallPathogenesis: "当前不形成可采纳的中医病机链",
      overallTherapy: redFlag ? "立即急诊或专科评估，不进入中药处方" : "补充信息或重新生成并复核M03",
      recommendedFormulaDirection: "暂不进入候选方药",
      recommendedFormulaNames: [],
      formulaSelectionMode: "none",
      evidence,
    },
    westernDiagnosis: {
      primary: {
        name: redFlag ? "急危重症风险待排除" : "症状性问题，病因待临床鉴别",
        status: redFlag ? "需排除" : "证据有限",
        confidence: redFlag ? "高" : "低",
        supportingFacts,
        limitations: [redFlag
          ? "本路径只确认急诊处置优先级，不替代现场诊断"
          : "当前M03未形成可信的完整结果"],
        suggestedChecks: [redFlag ? "立即按急诊或对应专科流程评估" : "由医生补充鉴别所需问诊、查体和检查"],
        evidence,
      },
      differentials: [],
    },
    pathogenesis: {
      summary: "中医病机尚未稳定，本次不做推断。",
      locationDifferentiation: {
        items: [], details: [], resolution: "unresolved", resolutionReason: "未形成可复核的病位证据", evidence,
      },
      natureDifferentiation: {
        items: [], rootDeficiency: [], branchExcess: [], basis: "", resolution: "unresolved", resolutionReason: "未形成可复核的病性证据", evidence,
      },
      symptomClusters: [],
      chain: [],
      uncertainties: uncertaintyItems,
    },
    therapy: {
      overallPrinciple: redFlag ? "急诊处置优先，不锁定中医治法" : "暂不锁定剂量级治法",
      subTherapies: [],
    },
    formula: null,
    nonPharma: null,
    lineageAdaptation: null,
    management: {
      redFlagLoop: redFlag ? "立即停止常规诊疗并转急诊；危及生命时呼叫120" : "病情加重或出现新的急危重线索时立即升级处置",
      mustCollect: gate.missingItems.slice(0, 12),
      followupSafetyNet: "完成现场评估或补录后再重新运行M03",
    },
  };
}

export function renderSafetyLimitedDiagnosisContract(
  state: CaseState,
  gate: SafetyGate,
  signedReasoning: ClinicalReasoningResultV2,
): string {
  return [
    buildSafetyLimitedDiagnosis(state, gate),
    "",
    "## 本节生成状态",
    gate.status === "red_flag"
      ? "已形成服务端签名的急症限定结果；本结果只用于急诊分流和阻断剂量处方，不声称已完成中医辨证。"
      : "本次M03未通过完整临床契约；已形成服务端签名的有限结果，明确阻断剂量处方并保留重新生成路径。",
    "",
    "<!-- DIAGNOSIS_JSON_START -->",
    JSON.stringify(signedReasoning, null, 2),
    "<!-- DIAGNOSIS_JSON_END -->",
  ].join("\n");
}

export function buildSafetyLimitedPrescription(gate: SafetyGate): string {
  return [
    "<!-- CDSS_NON_DOSE_PRESCRIPTION -->",
    "## 处方前必要信息核查",
    `**医生开方前需确认**：${[...gate.missingItems, ...gate.redFlags].join("；") || "需完成医生复核"}`,
    "**处方安全边界**：当前未满足剂量级候选处方安全门控，不生成中药饮片剂量、剂数、煎服法或西药/中成药用法用量。",
    "",
    "## 中药饮片处方",
    "当前不展示剂量级候选方药。请先完成急诊/转诊评估，或补充会直接影响用药安全的信息后重新分析。",
    "",
    "## 西药/中成药方案",
    "暂不生成联用、替代或对症用药方案。",
    "",
    "## 用药风险提示",
    `- **提示强度**：${gate.status === "red_flag" ? "强提示" : "信息不足提示"}`,
    `- **风险点**：${gate.redFlags.join("；") || gate.reasons.join("；")}`,
    // Reasons carry the gate rationale (e.g. 急诊指引/门禁原因). When concrete red flags already
    // occupy the risk line above, they must still be rendered instead of being silently dropped.
    ...(gate.redFlags.length > 0 && gate.reasons.length > 0
      ? [`- **急诊指引/门禁原因**：${gate.reasons.join("；")}`]
      : []),
    "- **医生动作**：补齐信息、完成红旗排查和院内审方复核后再考虑处方。",
  ].join("\n");
}

export function buildSafetyLimitedRisk(gate: SafetyGate): string {
  return [
    "## 处方安全总评",
    `**最高提示强度**：${gate.status === "red_flag" ? "强提示" : "信息不足提示"}`,
    `**综合风险判断**：${gate.status === "red_flag" ? "高风险" : "信息不足无法判断"}`,
    `**评级依据**：${gate.reasons.join("；")}`,
    `**医生需确认事项**：${[...gate.missingItems, ...gate.redFlags].join("；") || "请完善病历后复核"}`,
    "",
    "## 转诊评估",
    `**转诊建议**：${gate.status === "red_flag" ? "需要" : "暂不判断"}`,
    `**转诊指征**：${gate.redFlags.join("；") || "无明确红旗，但关键安全信息未补齐"}`,
    `**紧急程度**：${gate.status === "red_flag" ? "急诊" : "完善信息后评估"}`,
    "",
    "## 随访时间轴",
    "| 时间点 | 医生/患者动作 | 观察指标 | 触发处置 |",
    "|------|--------------|---------|---------|",
    `| 当前 | 完善${gate.missingItems.join("、") || "红旗排查"} | 主诉、舌脉、四诊问诊，以及已提示但不完整的过敏/用药/特殊人群信息 | 信息未补齐前不生成剂量级候选处方 |`,
    "| 补齐后 | 重新发起辅助推理 | 证候、病机、风险提示 | 符合安全槽位后进入候选方案 |",
  ].join("\n");
}

function riskSignalLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter((line) =>
      line.length > 0 &&
      !/^#{1,6}\s/.test(line) &&
      !/^\|?\s*(提示强度|风险说明|证据依据|医生动作|最高提示强度|综合风险判断)\s*\|?/.test(line) &&
      !/^-{2,}|^\|[-:|\s]+$/.test(line)
    );
}

export function isConditionalSafetyNetRiskLine(line: string): boolean {
  const text = line.trim().replace(/\s+/g, "");
  if (!text) return false;
  if (/(?:患者须知|用药须知|健康宣教|随访|观察指标|触发处置|安全性观察|红旗症状|红旗预警).{0,80}(?:如|若|一旦|当|出现|发生|新发|突发|急性|加重|无效|未解除)/.test(text)) {
    return true;
  }
  if (/(?:如|若|一旦|当).{0,120}(?:出现|发生|新发|加重|无效|未解除).{0,120}(?:请|应|需|建议|立即|及时|就医|转诊|急诊|暂停|停止|复评|复核|处理)/.test(text)) {
    return true;
  }
  if (/(?:出现|发生|新发|加重|无效|无改善|未解除).{0,100}(?:时|则).{0,80}(?:请|应|需|建议|立即|及时|就医|转诊|急诊|暂停|停止|复评|复核|处理)/.test(text)) {
    return true;
  }
  return /(?:转诊指征|推荐科室|紧急程度).{0,80}(?:出现红旗|出现.*急诊|突发|急性|按主诉|常规随访)/.test(text);
}

export function isRiskLineNegatedOrEnumerative(line: string): boolean {
  return /(未见|未提示|未发现|无明确|暂无|没有|否认|排除|不提示|不构成|低风险|未命中|暂不需要|不需要|无需|仅为枚举|风险分级|低风险\s*\/\s*需关注\s*\/\s*高风险|强提示\s*\/\s*一般提示|强提示\s*\/\s*一般提示\s*\/\s*信息不足提示)/.test(line) ||
    isConditionalSafetyNetRiskLine(line);
}

export function hasCurrentRiskLine(text: string, pattern: RegExp): boolean {
  return riskSignalLines(text).some((line) => pattern.test(line) && !isRiskLineNegatedOrEnumerative(line));
}

function extractMarkdownSections(text: string, headingPattern: RegExp): string {
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s*(.+?)\s*$/);
    if (heading) {
      if (current) sections.push(current.join("\n"));
      current = headingPattern.test(heading[1] || "") ? [line] : null;
      continue;
    }
    if (current) current.push(line);
  }

  if (current) sections.push(current.join("\n"));
  return sections.join("\n\n");
}

function riskReviewSource(state: CaseState): string {
  const riskSectionPattern = /(用药风险提示|处方安全总评|确定性处方风险复核|合理用药审方|灵犀统一审方|十八反十九畏|处方风险复核|安全总评)/;
  return [
    state.riskAssessment || "",
    extractMarkdownSections(state.prescription || "", riskSectionPattern),
    extractMarkdownSections(state.diagnosis || "", riskSectionPattern),
  ].filter(Boolean).join("\n");
}

export function deriveFirstReviewTiming(state: CaseState, hasStrongRisk: boolean): string {
  if (hasStrongRisk) return "调整处方后当日复核；若采纳，1-3天内随访";
  const candidate = state.reasoningPrescribe?.formula?.candidates?.[0] ||
    (state.reasoningV2?.stage === "prescribe" ? state.reasoningV2.formula?.candidates?.[0] : undefined);
  const followUpNode = candidate?.decoction?.followUpNode?.trim();
  return followUpNode || "3-5天后复诊或线上随访";
}

function hasStructuredDoseCandidate(state: CaseState): boolean {
  const candidates = [
    ...(state.reasoningPrescribe?.formula?.candidates || []),
    ...(state.reasoningV2?.stage === "prescribe" ? state.reasoningV2.formula?.candidates || [] : []),
  ];
  return candidates.some((candidate) =>
    Array.isArray(candidate.herbs) && candidate.herbs.length > 0 &&
    candidate.herbs.every((herb) => typeof herb.dose === "string" && /\d(?:\.\d+)?\s*(?:mg|g|克|钱|mL|ml|毫升)/i.test(herb.dose))
  );
}

function buildNonDoseRiskFollowup(gate: SafetyGate): string {
  const pending = gate.missingItems.join("、") || "结构化剂量方案及其处方级安全复核";
  return [
    "## 处方安全总评",
    "**最高提示强度**：信息不足提示",
    "**综合风险判断**：本轮未生成剂量级处方，不作处方用药风险或疗效判定，也不生成用药阶段随访安排。",
    `**当前受限状态**：${pending}尚未完成；不得将本轮结果表述为可采纳或可审阅的剂量级候选处方。`,
    "",
    "## 非药物与继续评估",
    "**当前建议**：仅进行与主诉相适应的作息、饮食、情志、活动等非药物管理，并继续观察症状变化；不据此自行用药。",
    `**继续评估重点**：补足或复核${pending}，同时记录主诉、伴随症状、舌脉及必要生命体征。`,
    "**重新评估条件**：安全信息和适用的个体化剂量规则补足后，重新发起处方级评估；出现急性加重或红旗症状时立即转入现场评估或急诊处置。",
    "",
    "## 后续评估时间轴",
    "| 时间点 | 医生/患者动作 | 观察指标 | 触发处置 |",
    "|------|--------------|---------|---------|",
    `| 当前 | 继续临床评估并补足${pending} | 主诉、伴随症状、舌脉及必要生命体征 | 症状急性加重或出现红旗时及时就医 |`,
    "| 补足后 | 重新进行辨证与处方级安全评估 | 个体化剂量依据、过敏/现用药及特殊人群风险 | 仍不满足安全边界时继续保持非剂量状态 |",
  ].join("\n");
}

function buildRestrictedDoseRiskFollowup(reasons: string[]): string {
  const reasonText = reasons.join("；") || "处方级安全筛查尚未完成";
  return [
    "## 处方安全总评",
    "**最高提示强度**：信息不足提示",
    "**综合风险判断**：本轮虽存在结构化剂量候选，但处方级安全筛查未完成，当前为受限状态。",
    `**受限原因**：${reasonText}。`,
    "**医生需确认事项**：当前候选不得采纳、执行或转写；仅可保留为待复核记录。",
    "",
    "## 继续评估",
    `**当前动作**：完成${reasonText}，并结合患者现场情况进行人工安全复核。`,
    "**重新评估条件**：受限原因解除后，重新计算安全门并再次完成处方级风险评估。",
    "**期间处置**：仅提供与主诉相适应的非药物管理和症状观察；出现急性加重或红旗症状时及时就医。",
    "",
    "## 后续评估时间轴",
    "| 时间点 | 医生/患者动作 | 观察指标 | 触发处置 |",
    "|------|--------------|---------|---------|",
    `| 当前 | 完成受限项并人工复核 | ${reasonText} | 未完成前保持不可采纳、不可执行 |`,
    "| 受限解除后 | 重新进行处方级安全评估 | 剂量依据、过敏/现用药及特殊人群风险 | 仍不满足安全边界时继续保持受限状态 |",
  ].join("\n");
}

export function buildDeterministicRiskFollowup(state: CaseState): string {
  const gate = state.safetyGate || evaluateSafetyGate(state);
  if (gate.status === "red_flag") return buildSafetyLimitedRisk(gate);
  if (!hasStructuredDoseCandidate(state)) return buildNonDoseRiskFollowup(gate);
  const hardDoseBoundary = hardDoseSafetyBoundaryReasons(state);
  if (hardDoseBoundary.length > 0) return buildRestrictedDoseRiskFollowup(hardDoseBoundary);

  const vitalAdvisories = unparseableVitalAdvisories(state);
  const missingAdvisory = gate.missingItems.length > 0 ? gate.missingItems.join("、") : "";
  const riskSource = riskReviewSource(state);
  // 审方结论只影响提示强度和医生复核动作，不参与硬安全门控。
  const hasStrongRisk = hasCurrentRiskLine(
    riskSource,
    /(强提示|(?<!最)高风险|禁用|十八反|十九畏|超出知识库上限|确定性处方风险复核未完成|审方未完成|不能等同为无风险)/,
  );
  // NOTE: pure evidence-provenance tokens ("待检索"/"证据不足") are intentionally NOT here — every
  // model-inference prescription cites them, so scanning for them mislabels benign cases as 中风险.
  const hasReviewRisk = Boolean(missingAdvisory) || hasCurrentRiskLine(riskSource, /(一般提示|需复核|慎用|相互作用|过敏|特殊人群|信息不足提示|用药史|当前用药)/);
  const highest = hasStrongRisk ? "强提示" : hasReviewRisk ? "一般提示" : "说明性提示";
  const overall = hasStrongRisk ? "较高风险，需调整或复核后采纳" : hasReviewRisk ? "中等风险，需医生复核后采纳" : "当前未识别确定性高危用药冲突，仍需医生最终确认";
  const doctorAction = hasStrongRisk
    ? "候选处方命中强提示或审方未完成，请调整剂量/药味、完善复核或请药师复核后再采纳。"
    : hasReviewRisk
      ? "处方可作为候选方案审阅，请结合过敏史、现用药、特殊人群状态和院内规则完成复核。"
      : "当前无确定性强提示；仍需医生按病情、说明书和院内药事规则最终确认。";
  const firstReview = deriveFirstReviewTiming(state, hasStrongRisk);
  const trigger = hasStrongRisk
    ? "强提示未解除、症状加重或出现明显不良反应"
    : "症状无改善、睡眠/疼痛/消化等核心指标恶化，或出现皮疹、腹泻、头晕等疑似不良反应";

  return [
    "## 处方安全总评",
    `**最高提示强度**：${highest}`,
    `**综合风险判断**：${overall}`,
    `**评级依据**：${hasStrongRisk ? "处方后置复核命中强提示或存在未完成的确定性审方链路。" : hasReviewRisk ? "病历或处方中存在需医生复核的用药、过敏、特殊人群或联用信息。" : "处方后置复核未提示明确高危冲突。"}`,
    `**医生需确认事项**：${doctorAction}`,
    ...(missingAdvisory ? [`**待核实信息**：${missingAdvisory}。这些未知项不阻断候选方案展示，正式采纳前请结合临床实际确认。`] : []),
    ...(vitalAdvisories.length > 0 ? [`**生命体征录入提示**：${vitalAdvisories.join("；")}`] : []),
    "",
    "## 随访管理方案",
    `**首次复诊时间**：${firstReview}`,
    "**复诊评估重点**：主诉核心症状变化、舌脉变化、睡眠/饮食/二便、生命体征、用药依从性和不良反应。",
    "**疗效评价标准**：主要症状较首诊改善、伴随症状减轻、生活功能恢复，且无明显不良反应。",
    "**安全性观察**：皮疹瘙痒、胃肠不适、头晕乏力、心悸胸闷、出血倾向，以及与现用西药/中成药的联用风险。",
    `**无效或加重的处置预案**：${trigger}时，停止自动沿用候选方案，由医生复评辨证、复核处方风险并考虑转诊/检查。`,
    "",
    "## 随访时间轴",
    "| 时间点 | 医生/患者动作 | 观察指标 | 触发处置 |",
    "|------|--------------|---------|---------|",
    "| 当日 | 医生完成处方复核并交代服法与禁忌 | 处方剂量、煎服法、过敏/现用药及已测生命体征 | 强提示未解除时调整方案并复核 |",
    `| ${firstReview} | 复诊或线上随访，记录症状评分和舌脉变化 | 主诉改善度、睡眠/饮食/二便、舌脉、ADR | 无效、加重或ADR时复评辨证并调整方案 |`,
    "| 7-14天 | 根据疗效决定续方、减量、加减或进一步检查 | 疗效稳定性、复发、药物耐受性 | 疗效不稳定或出现明显不良反应时暂停续方并复评 |",
    "",
    "## 中医康复管理",
    "根据证候与主诉进行饮食、作息、情志和运动管理；避免自行叠加中药、中成药或镇静催眠类药物，复诊时携带全部现用药清单。",
  ].join("\n");
}

export function buildForcedIncompleteRiskFollowup(state: CaseState): string {
  const gate = state.safetyGate || evaluateSafetyGate(state);
  const missing = gate.missingItems.join("、") || "关键四诊信息";
  return [
    "## 处方安全总评",
    "**最高提示强度**：待临床复核",
    "**综合风险判断**：本轮已按医生选择，基于现有资料形成候选方案；资料缺口降低判断把握度，但不阻断报告生成。",
    `**待复核信息**：${missing}。请结合本次接诊可获得的资料核对证候、病机、方药匹配与剂量合理性。`,
    "",
    "## 随访管理方案",
    "**首次复诊时间**：结合病情轻重和候选方案，由医生确定首次复诊节点。",
    `**复诊评估重点**：按临床可得情况补录${missing}，复核主症、兼症、舌脉变化与用药反应。`,
    "**安全性观察**：皮疹瘙痒、胃肠不适、头晕乏力、心悸胸闷、出血倾向及原症加重。",
    "**无效或加重的处置预案**：停止自动沿用候选方案，由医生重新辨证并复核处方。",
    "",
    "## 随访时间轴",
    "| 时间点 | 医生/患者动作 | 观察指标 | 触发处置 |",
    "|------|--------------|---------|---------|",
    `| 采纳前 | 结合临床实际复核${missing} | 证候、病机、方药匹配、剂量与禁忌 | 复核结论改变时调整候选方案 |`,
    "| 首次随访 | 记录疗效与不良反应 | 主症变化、舌脉、胃肠反应及过敏表现 | 无效、加重或ADR时停用并复评 |",
  ].join("\n");
}

export function applySafetyLimitedOutcome(state: CaseState): CaseState {
  const gated = withSafetyGate(state);
  const gate = gated.safetyGate!;
  return {
    ...gated,
    diagnosis: buildSafetyLimitedDiagnosis(gated, gate),
    prescription: buildSafetyLimitedPrescription(gate),
    riskAssessment: buildSafetyLimitedRisk(gate),
    phase: "done",
  };
}

export function applyCompletenessLimitedOutcome(state: CaseState): CaseState {
  const gated = withSafetyGate(state);
  const completenessLevel = gated.completeness?.level || "未评估";
  const completenessText = completenessLevel === "C" ? "可生成候选方案" : completenessLevel === "B" ? "可初步推理" : "信息不足";
  const gate: SafetyGate = {
    status: "needs_information",
    allowDiagnosis: false,
    allowDosePrescription: false,
    action: "complete_before_prescription",
    missingItems: [`辨证信息完整度不足（当前：${completenessText}，需达到：可生成候选方案）`],
    redFlags: [],
    reasons: ["主诉、舌脉或核心辨证证据仍不足以支撑剂量级候选处方。年龄和非高风险场景下的生命体征不作为通用阻断项；性别/生理状态、过敏史与当前用药须在 M04 前明确。"],
  };
  return {
    ...gated,
    safetyGate: gate,
    diagnosis: buildSafetyLimitedDiagnosis(gated, gate),
    prescription: buildSafetyLimitedPrescription(gate),
    riskAssessment: buildSafetyLimitedRisk(gate),
    phase: "done",
  };
}

export function sanitizeCaseStateForModel(state: CaseState): CaseState {
  const patientName = state.patient.name || state.hisRecord?.fields?.patientName || "";
  const limitText = (value?: string, max = 6000) => {
    if (!value) return value;
    return value.length > max ? `${value.slice(0, max)}\n[内容已按模型上下文预算截断]` : value;
  };
  const scrub = (value?: string, max = 6000) => {
    if (!value) return value;
    return limitText(scrubPhi(value, patientName), max);
  };
  const scrubHeadTail = (value?: string, max = 12000) => {
    if (!value) return value;
    return limitModelTextHeadTail(scrubPhi(value, patientName), max);
  };
  const scrubFields = (fields: HisRecordSnapshot["fields"] | undefined): HisRecordSnapshot["fields"] => {
    const next: HisRecordSnapshot["fields"] = {};
    for (const [key, value] of Object.entries(fields || {})) {
      next[key as keyof HisRecordSnapshot["fields"]] = scrub(value);
    }
    return { ...next, patientName: undefined };
  };
  const scrubUnknown = <T>(value: T, maxStringLength = 6000): T =>
    sanitizeUnknownForModel(value, { patientName, maxStringLength });
  const safeHisRecord = state.hisRecord
    ? {
        schemaVersion: state.hisRecord.schemaVersion,
        source: state.hisRecord.source,
        caseId: "deidentified-case",
        updatedAt: "",
        tongueImageUploaded: state.hisRecord.tongueImageUploaded,
        fields: scrubFields(state.hisRecord.fields),
        // The latest clinical supplement is often appended to a long HIS note. Preserve the real
        // tail after PHI scrubbing so semantic triage can still see it; the marker also prevents a
        // projected source from being mistaken for full coverage and signed as complete.
        rawText: scrubHeadTail(state.hisRecord.rawText, 12000) || "",
      }
    : undefined;
  // Build an explicit clinical DTO. Spreading CaseState here would silently forward future UI,
  // audit, revision or persistence fields to an external model before they receive a PHI review.
  return {
    id: "deidentified-case",
    phase: state.phase,
    patient: {
      name: undefined,
      sex: scrub(state.patient.sex, 200),
      age: state.patient.age,
      occupation: generalizeOccupation(state.patient.occupation),
    },
    chiefComplaint: scrub(state.chiefComplaint) || "",
    symptoms: scrubUnknown(state.symptoms) as Record<string, unknown>,
    tongue: scrub(state.tongue),
    pulse: scrub(state.pulse),
    faceNote: scrub(state.faceNote),
    tongueImageDesc: scrub(state.tongueImageDesc),
    tongueDx: state.tongueDx ? scrubUnknown(state.tongueDx, 2000) as typeof state.tongueDx : undefined,
    faceCapture: state.faceCapture ? scrubUnknown(state.faceCapture, 2000) as typeof state.faceCapture : undefined,
    vitals: state.vitals ? scrubUnknown(state.vitals) as Record<string, unknown> : undefined,
    pastHistory: scrub(state.pastHistory),
    medicationHistory: scrub(state.medicationHistory),
    allergyHistory: scrub(state.allergyHistory),
    tcmLineagePreference: scrub(state.tcmLineagePreference, 500),
    clinicTreatmentCapabilities: state.clinicTreatmentCapabilities?.slice(0, 24),
    clinicTreatmentCapabilitiesRestricted: state.clinicTreatmentCapabilitiesRestricted,
    hisRecord: safeHisRecord,
    safetyGate: state.safetyGate ? scrubUnknown(state.safetyGate, 2000) as SafetyGate : undefined,
    clinicalFacts: state.clinicalFacts ? scrubUnknown(state.clinicalFacts, 4000) as typeof state.clinicalFacts : undefined,
    completeness: { ...state.completeness },
    questionRounds: state.questionRounds,
    maxQuestionRounds: state.maxQuestionRounds,
    skipDifferentiationGate: state.skipDifferentiationGate,
    conversation: state.conversation
      .slice(-10)
      .map((item) => ({ ...item, content: limitText(scrub(item.content) || "", 2000) || "" })),
    diagnosis: scrub(state.diagnosis, 30000),
    prescription: scrub(state.prescription, 30000),
    riskAssessment: scrub(state.riskAssessment, 30000),
    // A previous result is retained solely for read-only UI continuity. Sending it to the model
    // would contaminate the new run with stale conclusions and defeat the independent rerun.
    previousResult: undefined,
    reasoningDiagnose: state.reasoningDiagnose ? scrubUnknown(state.reasoningDiagnose, 12000) as typeof state.reasoningDiagnose : undefined,
    reasoningPrescribe: state.reasoningPrescribe ? scrubUnknown(state.reasoningPrescribe, 12000) as typeof state.reasoningPrescribe : undefined,
    reasoningV2: state.reasoningV2 ? scrubUnknown(state.reasoningV2, 12000) as typeof state.reasoningV2 : undefined,
    safetyLocked: state.safetyLocked,
  };
}

export function sanitizeUnknownForModel<T>(
  value: T,
  opts?: { patientName?: string; maxStringLength?: number; maxDepth?: number },
): T {
  const patientName = opts?.patientName || "";
  const maxStringLength = opts?.maxStringLength ?? 6000;
  const maxDepth = opts?.maxDepth ?? 8;
  return scrubUnknownValue(value, patientName, maxStringLength, maxDepth, 0) as T;
}

function scrubUnknownValue(
  value: unknown,
  patientName: string,
  maxStringLength: number,
  maxDepth: number,
  depth: number,
): unknown {
  if (value == null) return value;
  if (typeof value === "string") return limitModelText(scrubPhi(value, patientName), maxStringLength);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= maxDepth) return "[嵌套内容已截断]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) =>
      scrubUnknownValue(item, patientName, maxStringLength, maxDepth, depth + 1)
    );
  }
  if (typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
      const safeKey = scrubPhi(key, patientName)
        .replace(/[\u4e00-\u9fa5]{2,4}(?=(?:病情|症状|主诉|记录|备注|信息|情况))/g, "[已脱敏]");
      const keyLooksIdentifying = /(name|姓名|患者名|联系人|身份证|证件|电话|手机|地址|住址|就诊号|门诊号|住院号|病案号|病历号|病例号|电子病历号|医疗记录号|患者编号|mrn|medical.?record|record.?number|patient.?id)/i.test(key);
      next[safeKey] = keyLooksIdentifying
        ? undefined
        : scrubUnknownValue(item, patientName, maxStringLength, maxDepth, depth + 1);
    }
    return next;
  }
  return undefined;
}

function limitModelText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n[内容已按模型上下文预算截断]` : value;
}

function limitModelTextHeadTail(value: string, max: number): string {
  if (value.length <= max) return value;
  const marker = "\n【原始病历中段已按模型上下文预算省略】\n";
  const available = Math.max(2, max - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function scrubPhi(text: string, patientName = ""): string {
  let next = text;
  if (patientName) next = next.replaceAll(patientName, "[已脱敏]");
  return scrubQuasiIdentifierText(next
    .replace(
      /((?:姓名|患者|家属|联系人|陪同者|监护人)\s*[:：]?\s*)[\u3400-\u9fff]{1,20}[·•][\u3400-\u9fff·•]{1,30}(?=\s*[,，；;。\s]*(?:男|女|\d{1,3}\s*岁|电话|手机|就诊|来诊|入院|出院|诉|称|反映|表示))/g,
      "$1[已脱敏]",
    )
    .replace(/(?:姓名|患者|家属|联系人|陪同者|监护人)\s*[:：]?\s*[A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3}/g, (match) => {
      const label = match.match(/^(姓名|患者|家属|联系人|陪同者|监护人)/)?.[1] || "人员";
      return `${label}：[已脱敏]`;
    })
    .replace(/(^|[；;。\n]\s*)([A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3})(?=\s*(?:昨夜|今日|今晨|近日|近\d|来诊|就诊|入院|出院|自述|反映|称|表示|出现|发生|患|失眠|头痛|头晕|胸痛|腹痛|发热|咳嗽|心悸))/g, "$1[已脱敏]")
    .replace(/(^|[；;。\n]\s*)([A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3})(?=\s*[\u4e00-\u9fa5])/g, "$1[已脱敏]")
    .replace(/姓名\s*[:：]?\s*[^，；。\n]+/g, "姓名：[已脱敏]")
    .replace(/(?:患者|家属|联系人|陪同者|监护人|医生|医师)\s*[:：]?\s*[\u4e00-\u9fa5]{2,4}(?=[，,；。\s]|反映|诉|称|表示|告知|建议|记录)/g, (match) => {
      const label = match.match(/^(患者|家属|联系人|陪同者|监护人|医生|医师)/)?.[1] || "人员";
      return `${label}[已脱敏]`;
    })
    .replace(/患者\s*[\u4e00-\u9fa5]{2,4}(?=[，,；。\s]|男|女|\d{1,3}\s*岁)/g, "患者[已脱敏]")
    .replace(/(本例|该患者|病例|病人|患儿)\s*[\u4e00-\u9fa5]{2,4}?(?=(?:既往|曾经|曾有|近|昨|今|因|诉|称|反映|表示|出现|发生|患|有|于|睡|入睡|失眠|头痛|头晕|胸痛|腹痛|发热|咳嗽|心悸|就诊|来诊|男|女|\d{1,3}\s*岁))/g, "$1[已脱敏]")
    .replace(/(^|[，,；。\s:：]|患者|家属|联系人|陪同者|监护人)((?:欧阳|司马|上官|诸葛|[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包左石崔吉龚程邢裴陆荣翁荀羊惠甄曲封芮储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶黎乔苍双闻莘党翟谭贡劳姬申扶堵冉宰郦雍却璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧沃利蔚越夔隆师巩厍聂晁勾敖融冷辛阚那简饶空曾沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公]))[\u4e00-\u9fa5]{1,2}(?=(?:近|昨|今|因|诉|称|反映|表示|出现|发生|患|有|于|睡|入睡|失眠|头痛|头晕|胸痛|腹痛|发热|咳嗽|心悸|就诊|来诊))/g, (_match, prefix: string) => `${prefix}[已脱敏]`)
    .replace(/^([\u4e00-\u9fa5]{2,4})(?=[，,；。\s]*(?:男|女|\d{1,3}\s*岁))/g, "[已脱敏]")
    .replace(/\b1[3-9]\d{9}\b/g, "[手机号已脱敏]")
    .replace(/\b0\d{2,3}-?\d{7,8}\b/g, "[电话已脱敏]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已脱敏]")
    .replace(/\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, "[证件号已脱敏]")
    .replace(/(身份证号?|证件号?|医保号|社保号|就诊号|门诊号|住院号|病案号|病历号|病例号|病例编号|电子病历号|医疗记录号|患者编号|MRN)\s*#?\s*[:：=]?\s*[A-Za-z0-9][A-Za-z0-9._/#-]{3,}/gi, (_match, label: string) => {
      return `${label}：[已脱敏]`;
    })
    .replace(/(?:住址|地址|家庭住址|工作单位)\s*[:：]?\s*[^，；。\n]+/g, (match) => {
      const label = match.split(/[:：]/)[0] || "地址";
      return `${label}：[已脱敏]`;
    })
    .replace(/(?:出生日期|出生年月|生日)\s*[:：]?\s*\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?/g, (match) => {
      const label = match.split(/[:：]/)[0] || "出生日期";
      return `${label}：[已脱敏]`;
    }));
}

export function sanitizeFreeTextForExternalClinicalService(text: string, explicitNames: string[] = []): string {
  let next = text;
  for (const name of explicitNames) {
    const cleaned = name.trim();
    if (cleaned) next = next.replaceAll(cleaned, "[已脱敏]");
  }
  return scrubPhi(next)
    .replace(/<!--\s*DIAGNOSIS_JSON_(?:START|END)\s*-->/gi, "[用户输入结构标记已移除]")
    .replace(/<<<CDSS_STREAM_FINAL>>>/g, "[用户输入流标记已移除]");
}

export function sanitizeFreeTextForModel(text: string): string {
  return sanitizeFreeTextForExternalClinicalService(text);
}

export function markdownNdjsonResponse(markdown: string): Response {
  const body = `${JSON.stringify({ content: markdown })}\n${JSON.stringify({ content: "[END]" })}\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
