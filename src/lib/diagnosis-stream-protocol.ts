export const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";

export const M03_DRAFT_MODULES = [
  "m03.western",
  "m03.syndrome",
  "m03.pathogenesis",
  "m03.therapy",
] as const;

export type M03DraftModule = (typeof M03_DRAFT_MODULES)[number];

export type StreamModuleDraftFrame = {
  type: "module_draft";
  module: M03DraftModule;
  revision: number;
  content: string;
};

export function parseStreamModuleDraftFrame(value: unknown): StreamModuleDraftFrame | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.type !== "module_draft" ||
    !M03_DRAFT_MODULES.includes(row.module as M03DraftModule) ||
    !Number.isInteger(row.revision) ||
    Number(row.revision) < 1 ||
    typeof row.content !== "string" ||
    !row.content.trim() ||
    row.content.length > 8_000
  ) {
    return null;
  }
  return row as StreamModuleDraftFrame;
}
