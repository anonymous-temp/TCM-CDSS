import { createHash } from "node:crypto";

export type KnowledgeTelemetryStage = "diagnose" | "prescribe" | "assess";

type KnowledgeTrace = {
  at: string;
  stage: KnowledgeTelemetryStage;
  queryHashes: string[];
  injectedIds: string[];
  referencedIds: string[];
};

type StageAggregate = {
  total: number;
  injectedIds: number;
  referencedIds: number;
  zeroReferenceFinals: number;
};

type KnowledgeTelemetryStore = {
  schemaVersion: "tcm-cdss-knowledge-telemetry-v1";
  startedAt: string;
  updatedAt: string;
  total: number;
  zeroReferenceFinals: number;
  stages: Record<string, StageAggregate>;
  recent: KnowledgeTrace[];
};

const KNOWLEDGE_TELEMETRY_STORE = Symbol.for("tcm-cdss.knowledge-telemetry.v1");
const MAX_RECENT_TRACES = 100;
const GOVERNED_ID = /\b(?:EVID|LOCAL|OFFICIAL|TCM|MED)-[A-Z0-9_-]{2,120}\b/g;

function store(): KnowledgeTelemetryStore {
  const root = globalThis as typeof globalThis & { [KNOWLEDGE_TELEMETRY_STORE]?: KnowledgeTelemetryStore };
  if (!root[KNOWLEDGE_TELEMETRY_STORE]) {
    const now = new Date().toISOString();
    root[KNOWLEDGE_TELEMETRY_STORE] = {
      schemaVersion: "tcm-cdss-knowledge-telemetry-v1",
      startedAt: now,
      updatedAt: now,
      total: 0,
      zeroReferenceFinals: 0,
      stages: {},
      recent: [],
    };
  }
  return root[KNOWLEDGE_TELEMETRY_STORE];
}

function uniqueIds(value: string): string[] {
  return [...new Set(value.match(GOVERNED_ID) || [])].sort();
}

function queryHashes(evidenceContext: string): string[] {
  return [...new Set(evidenceContext.split("\n")
    .filter((line) => line.startsWith("检索词："))
    .map((line) => line.slice("检索词：".length).trim())
    .filter(Boolean)
    .map((query) => `sha256:${createHash("sha256").update(query).digest("hex").slice(0, 16)}`))];
}

export function recordCdssKnowledgeTrace(input: {
  stage: KnowledgeTelemetryStage;
  evidenceContext: string;
  finalContent: string;
}): void {
  const injectedIds = uniqueIds(input.evidenceContext);
  const injected = new Set(injectedIds);
  const referencedIds = uniqueIds(input.finalContent).filter((id) => injected.has(id));
  const trace: KnowledgeTrace = {
    at: new Date().toISOString(),
    stage: input.stage,
    queryHashes: queryHashes(input.evidenceContext),
    injectedIds,
    referencedIds,
  };
  const state = store();
  const aggregate = state.stages[input.stage] || {
    total: 0,
    injectedIds: 0,
    referencedIds: 0,
    zeroReferenceFinals: 0,
  };
  aggregate.total += 1;
  aggregate.injectedIds += injectedIds.length;
  aggregate.referencedIds += referencedIds.length;
  if (referencedIds.length === 0) {
    aggregate.zeroReferenceFinals += 1;
    state.zeroReferenceFinals += 1;
  }
  state.stages[input.stage] = aggregate;
  state.total += 1;
  state.updatedAt = trace.at;
  state.recent.push(trace);
  if (state.recent.length > MAX_RECENT_TRACES) state.recent.shift();
}

export function getCdssKnowledgeTelemetrySnapshot(): KnowledgeTelemetryStore {
  return structuredClone(store());
}

export function resetCdssKnowledgeTelemetry(): void {
  const root = globalThis as typeof globalThis & { [KNOWLEDGE_TELEMETRY_STORE]?: KnowledgeTelemetryStore };
  delete root[KNOWLEDGE_TELEMETRY_STORE];
}
