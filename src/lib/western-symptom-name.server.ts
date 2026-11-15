import "server-only";
import { resolveIcd10Diagnosis } from "./icd10-diagnosis-coding.server";

/** 与病名核对共享的 ICD 症状级判据；症状不查诊断标准。 */
const SYMPTOM_CODE_OUTSIDE_R = /^(?:M25\.5|M54|M79\.6|K59\.0|A09\.9|K92\.2|H93\.1)/u;
export function symptomLevelWesternName(name: string): boolean {
  const core = name.trim().replace(/待查$/u, "");
  if (core.length < 2) return false;
  const code = resolveIcd10Diagnosis(core)?.code || resolveIcd10Diagnosis(core.replace(/^[多双单左右]{1,2}/u, ""))?.code || "";
  return /^R/iu.test(code) || SYMPTOM_CODE_OUTSIDE_R.test(code);
}
