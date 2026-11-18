/** Bump when the prompt, outline or acceptance policy changes. */
export const FINAL_RATIONALE_VERSION = "r1067-5";
export type FinalRationaleMode = "off" | "shadow" | "on";

export function finalRationaleMode(): FinalRationaleMode {
  const value = process.env.CDSS_M03_FINAL_RATIONALE;
  if (value === "on" || value === "shadow" || value === "off") return value;
  // 缺省：生产开、其余关（与阶段结果复用、模型调用记忆同一口径——测试与本机开发用桩反复跑同一输入，不该多出一次模型调用）。
  return process.env.NODE_ENV === "production" ? "on" : "off";
}

export function finalRationaleStageIdentity(): string {
  const mode = finalRationaleMode();
  return mode === "off" ? "" : `|${mode}:${FINAL_RATIONALE_VERSION}`;
}

/**
 * 舌、脉都有记录的病历才定稿后重写两段。第五十轮实测（qwen4-max 同一评审，301 对，按本模块自己的舌脉读法分组）：
 * 舌脉都有记录 258 份，诊断依据判错 27 → 23、无瑕疵通过 106 → 135；缺舌或缺脉 34 份，判错 6 → 9、无瑕疵通过 10 → 7
 * ——提纲要求交代舌、脉，缺记录时新文更容易写进病历没有的表现。这类病历保留原两段，也不多一次模型调用。
 * （最初提交里写的「77 份 8→4、110 份 16→19」用的是一个把结构化脉象字段漏读的粗分类，数字作废，方向相同。）
 * `CDSS_M03_FINAL_RATIONALE_SPARSE=true` 放开（测量用）。
 */
export function finalRationaleSparseRecordsEligible(): boolean {
  return process.env.CDSS_M03_FINAL_RATIONALE_SPARSE === "true";
}
