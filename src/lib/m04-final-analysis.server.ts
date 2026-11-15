import "server-only";
import { callFinalM04Task } from "./m04-final-task.server";
import { validateFinalFormulaAnalysis } from "./m04-final-analysis-validation";
import type { AnalysisSentence, FinalM04Snapshot, M04FinalContentIO } from "./m04-final-content-types";

export async function authorFinalFormulaAnalysis(snapshot: FinalM04Snapshot, io: M04FinalContentIO = {}, signal?: AbortSignal,
  timeoutMs = 2000): Promise<{ sentences: readonly AnalysisSentence[]; status: "authored" | "unavailable"; violations: readonly { sentenceId: string; code: string }[] }> {
  const draft = await callFinalM04Task(io, "analysis", {
    instruction: "只为最终药表写方义，不开药、不改角色、不写安全许可、不写加去换及数量。返回{fingerprint,sentences:[{id,kind,herbIds,role,sourceIds,targetRefs,text}]}。herb_group句式严格为「{herb:H1}为君药，原文功效小句。」；多药同组须角色相同、每味均有该功效原文。配伍interaction只可引用本方方解完整句、引用完整药组；未知作用不写。每味药尽量覆盖，缺来源就省略。不得参考旧方义。",
    snapshot,
  }, timeoutMs, signal);
  const result = validateFinalFormulaAnalysis(snapshot, draft);
  return { sentences: result.accepted, status: result.accepted.length ? "authored" : "unavailable", violations: result.violations };
}
