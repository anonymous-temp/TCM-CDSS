/** Bump when the prompt, outline or acceptance policy changes. */
export const FINAL_RATIONALE_VERSION = "r1067-2";
export type FinalRationaleMode = "off" | "shadow" | "on";

export function finalRationaleMode(): FinalRationaleMode {
  const value = process.env.CDSS_M03_FINAL_RATIONALE;
  return value === "on" || value === "shadow" ? value : "off";
}

export function finalRationaleStageIdentity(): string {
  const mode = finalRationaleMode();
  return mode === "off" ? "" : `|${mode}:${FINAL_RATIONALE_VERSION}`;
}
