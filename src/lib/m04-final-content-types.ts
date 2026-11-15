/** Internal only. Never spread these records into the public reasoning payload. */
export type SourceSpan = {
  id: string;
  kind: "kb" | "verified" | "textbook_application" | "textbook_function" | "formula_commentary";
  herbKey?: string; formulaKey?: string; text: string;
  sourceRef: string; sourceDigest: string; lineStart?: number; lineEnd?: number;
  start?: number; end?: number;
};
export type FinalHerb = {
  id: string; name: string; identity: string; formKey: string;
  role: string; functionText: string; functionSources: readonly SourceSpan[];
  targetRef: string; targetPathogenesis: string;
};
export type FormulaDelta = {
  status: "known" | "unavailable" | "ambiguous" | "self_devised";
  bases: readonly { key: string; name: string; book: string; variant?: string; evidenceRef: string }[];
  changes: readonly {
    id: string; baseKey: string;
    kind: "added" | "removed" | "substituted" | "preparation_changed" | "guide_omitted" | "guide_present";
    from?: string; to?: string; sourceRef: string;
    guideLocation?: "table" | "modification" | "decoction" | "history";
  }[];
};
export type PresentFinding = {
  id: string; quote: string; fieldRef: string; start: number; end: number;
  kind: "symptom" | "sign"; conceptId?: string;
};
export type ModificationOption = {
  id: string; findingId: string; herbKey: string; displayName: string;
  action: "加" | "减" | "调整"; applications: readonly SourceSpan[];
  textbookEntryId?: string; scope: "uncovered" | "weakly_covered";
};
export type FinalM04Snapshot = {
  fingerprint: string; candidateKey: string; name: string; constructionType: string;
  herbs: readonly FinalHerb[]; delta: FormulaDelta;
  modifications: readonly Record<string, unknown>[];
  commentaries: readonly SourceSpan[]; priorDigest: string;
  decoctionDigest: string; recordDigest: string; sourceVersion: string;
  /** Full immutable non-prose candidate, so doses/processing also invalidate authoring. */
  candidateDigest: string;
  clinicalContext: { primarySyndrome: string; therapy: unknown; findings: readonly PresentFinding[] };
};
export type AnalysisSentence = {
  id: string; kind: "herb_group" | "interaction" | "summary";
  herbIds: readonly string[]; role?: string; sourceIds: readonly string[];
  targetRefs: readonly string[]; text: string; count?: number;
};
export type M04Task = "findings" | "recall" | "select" | "verify" | "analysis";
/** Adapter owns provider choice (verify must use the other vendor). Payloads are detached and scrubbed. */
export type M04FinalContentIO = {
  /** Known name for the existing PHI scrubber; never included in the payload. */
  patientName?: string;
  call?: (task: M04Task, payload: unknown, signal: AbortSignal) => Promise<unknown>;
  report?: (event: string, details: Readonly<Record<string, unknown>>) => void;
};
export type JsonRecord = Record<string, unknown>;
export const asRecord = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
export const asRecords = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map(asRecord) : [];
export const asText = (value: unknown): string => typeof value === "string" ? value : "";
