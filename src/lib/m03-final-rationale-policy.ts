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
 * 舌、脉都有记录的病历才定稿后重写两段（第五十轮实测，qwen4-max 同一评审）：
 * 舌脉齐备 77 份，诊断依据判错 8 → 4；缺舌或缺脉 110 份，16 → 19——新文在稀疏病历上更容易写进病历没有的表现
 * （「咳时引痛」「耳道未见堵塞」「壮热」）。稀疏病历保留原两段，也不多一次模型调用。
 * `CDSS_M03_FINAL_RATIONALE_SPARSE=true` 放开（测量用）。
 */
export function finalRationaleSparseRecordsEligible(): boolean {
  return process.env.CDSS_M03_FINAL_RATIONALE_SPARSE === "true";
}
