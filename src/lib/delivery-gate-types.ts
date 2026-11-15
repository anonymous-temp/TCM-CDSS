/** Internal sidecars only. Never extend the clinical payload or signing schema. */
export type GateMode = "off" | "shadow" | "enforce";
export type DeliveryStage = "diagnose" | "prescribe" | "assess";
export type ExpectedDelta =
  | { kind: "rename"; from: string; to: string; authority: string }
  | { kind: "remove_unsupported"; quote: string; decisionId: string }
  | { kind: "grade"; from: string; to: string; sourceFactId: string }
  | { kind: "presentation"; ruleVersion: string }
  | { kind: "unclassified"; reason: string };
export interface RuleSpec {
  ruleId: string;
  ruleVersion: string;
  expected: ExpectedDelta;
  protected?: boolean;
}
export interface GateContext {
  requestId: string;
  stage: DeliveryStage;
  mode?: GateMode;
  phase?: string;
  /** JSON pointers for quotes, safety results, herb tables and machine fields. */
  protectedPaths?: readonly string[];
}
export interface RewriteEvent {
  eventId: string;
  requestId: string;
  stage: DeliveryStage;
  phase: string;
  ruleId: string;
  ruleVersion: string;
  path: string;
  previousPath?: string;
  occurrenceId: string;
  revision: number;
  before: string;
  after: string;
  expected: ExpectedDelta;
  attribution: "leaf" | "family" | "unattributed";
  parentEventId?: string;
  protected: boolean;
  tombstone?: boolean;
  /** Unbound leaf observations are not counted as extra changed fields. */
  observationOnly?: boolean;
}
export interface TextSlot { path: string; occurrenceId?: string; protected?: boolean }
export interface DeliveryCandidate { payload: unknown; visible?: string }
export interface SentenceSpan { start: number; end: number; text: string }
export interface SentenceChange extends SentenceSpan {
  sentenceId: string;
  path: string;
  occurrenceId: string;
  textHash: string;
  before: string;
  events: RewriteEvent[];
  previous?: string;
  next?: string;
  protected: boolean;
  deleted?: boolean;
  stale?: boolean;
}
export interface IntegrityFinding {
  sentenceId: string;
  code: string;
  source: "morphology" | "model";
  span?: SentenceSpan;
}
export interface IntegrityVerdict {
  sentenceId: string;
  status: "pass" | "malformed" | "meaning_changed" | "unknown";
  reason?: string;
}
export interface IntegrityEdit {
  sentenceId: string;
  path: string;
  start: number;
  end: number;
  textHash: string;
  expectedText: string;
  replacement: string;
  action: "delete" | "restore";
}
export interface IntegrityResult {
  verdicts: IntegrityVerdict[];
  findings: IntegrityFinding[];
  edits: IntegrityEdit[];
  requiresSafetyRender: string[];
  requiresRevalidation: boolean;
}
