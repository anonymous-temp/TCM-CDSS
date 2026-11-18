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
