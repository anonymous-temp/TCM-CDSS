import type { CaseState } from "./diagnosis-types";

/**
 * 「病历已记录的项目不得说成未提及」（2026-09-29，甲方 9.24/9.27 测评「逻辑矛盾」）。
 *
 * 病历写了「否认药物过敏史」，注意事项却说「当前用药与过敏史未提及」。HIS 没有传现用药，
 * 提示词里现用药一行是「未提及」，模型把它和已记录的过敏史并成了一句。服务端此前对注意事项
 * 只查长度、剂量字样与占位话术，不核对它和病历事实是否矛盾。
 *
 * 这里只做确定性的**删改**：句中声称「未提及/不详/未提供…」的对象里，凡病历已记录的（含「否认…」「无」），
 * 从主语里摘掉；摘完没有对象了，整句删掉。真正未记录的项照旧提示核实。不新增任何临床内容。
 */

export type RecordedHistoryFields = Readonly<{ allergy: boolean; medication: boolean; pastHistory: boolean }>;

const NOT_RECORDED_VALUE = /^(?:未提及|未记录|不详|未知|不清楚|待补充|—|-|\/)?$/;

function recorded(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.replace(/\s+/g, "").replace(/[。；;，,]+$/g, "");
  return Boolean(text) && !NOT_RECORDED_VALUE.test(text);
}

export function recordedHistoryFields(caseState: Pick<CaseState, "allergyHistory" | "medicationHistory" | "pastHistory"> | null | undefined): RecordedHistoryFields {
  return {
    allergy: recorded(caseState?.allergyHistory),
    medication: recorded(caseState?.medicationHistory),
    pastHistory: recorded(caseState?.pastHistory),
  };
}

// 语言学层：病历完整性句式（未提及/不详…）与三类病史的主语写法。
const MISSING_CLAIM = /(?:未提及|未明确|不详|未提供|未记录|未说明|未告知|尚未确认|尚不清楚|不清楚|情况未知)/;
const SUBJECTS = {
  allergy: "(?:药物|食物)?过敏(?:史|情况)?",
  medication: "(?:当前|目前|现|正在)?(?:用药|服药)(?:史|情况)?|现用药",
  pastHistory: "既往(?:病)?史|基础(?:疾)?病(?:史)?",
} as const;
const CONJUNCTION = "(?:与|和|及|以及|、|或)";

function removeSubject(sentence: string, subject: string): string {
  const pattern = `(?:${subject})`;
  return sentence
    .replace(new RegExp(`${pattern}${CONJUNCTION}`, "g"), "")
    .replace(new RegExp(`${CONJUNCTION}${pattern}`, "g"), "");
}

export function reconcileRecordedHistoryClaims(text: string, fields: RecordedHistoryFields): string {
  if (!text || !(fields.allergy || fields.medication || fields.pastHistory)) return text;
  const pieces = text.split(/(?<=[。；;！!])/);
  const out: string[] = [];
  for (const piece of pieces) {
    if (!MISSING_CLAIM.test(piece)) {
      out.push(piece);
      continue;
    }
    let sentence = piece;
    const mentioned = (Object.keys(SUBJECTS) as Array<keyof typeof SUBJECTS>)
      .filter((key) => new RegExp(SUBJECTS[key]).test(sentence));
    if (mentioned.length === 0) {
      out.push(piece);
      continue;
    }
    const recordedSubjects = mentioned.filter((key) => fields[key]);
    if (recordedSubjects.length === 0) {
      out.push(piece);
      continue;
    }
    if (recordedSubjects.length === mentioned.length) {
      // 句中声称缺失的对象全部已记录：整句是错的，删掉。
      continue;
    }
    for (const key of recordedSubjects) {
      sentence = removeSubject(sentence, SUBJECTS[key]);
      if (key === "allergy") sentence = sentence.replace(/(?:或|及|、)(?:曾有|有无|是否有|有)?(?:药物)?过敏(?:史)?/g, "");
    }
    out.push(sentence);
  }
  return out.join("");
}

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

/** 对 M04 载荷里医生/HIS 可见的叙述字段逐条做上面的删改（注意事项、适用说明、加减理由、调护）。 */
export function reconcileRecordedHistoryClaimsInPrescribeContent(content: string, fields: RecordedHistoryFields): string {
  if (!(fields.allergy || fields.medication || fields.pastHistory)) return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "prescribe") return content;
    let changed = false;
    const fix = (value: unknown): unknown => {
      if (typeof value !== "string") return value;
      const next = reconcileRecordedHistoryClaims(value, fields);
      if (next !== value) changed = true;
      return next;
    };
    const record = (value: unknown): Record<string, unknown> | undefined =>
      value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const nonPharma = record(reasoning.nonPharma);
    if (nonPharma) {
      if (Array.isArray(nonPharma.precautions)) {
        nonPharma.precautions = nonPharma.precautions
          .map(fix)
          .filter((item) => typeof item !== "string" || item.trim().length >= 6);
      }
      for (const key of ["diet", "lifestyle", "emotion", "exercise"] as const) nonPharma[key] = fix(nonPharma[key]);
    }
    const formula = record(reasoning.formula);
    for (const candidate of Array.isArray(formula?.candidates) ? formula.candidates : []) {
      const item = record(candidate);
      if (!item) continue;
      for (const key of ["applicable", "notApplicable"] as const) item[key] = fix(item[key]);
    }
    for (const modification of Array.isArray(formula?.modifications) ? formula.modifications : []) {
      const item = record(modification);
      if (item) item.reason = fix(item.reason);
    }
    if (!changed) return content;
    console.info("[tcm-cdss:telemetry] recorded_history_claim_reconciled", { stage: "prescribe" });
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}
