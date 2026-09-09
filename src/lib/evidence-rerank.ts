import { getBailianQwenConfig } from "./text-model";
import { readResponseTextLimited, UpstreamResponseTooLargeError } from "./http-response-limit";
import { cancelResponseBody } from "./http-response-lifecycle";

const MODEL = "qwen3-rerank";
const ENDPOINT = "https://dashscope.aliyuncs.com/compatible-api/v1/reranks";
const MAX_DOCUMENTS = 32;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 3000;
const INSTRUCTION = "Given a clinical evidence retrieval query, rank the supplied guidelines and research summaries by their relevance and applicability to the clinical question. Consider the presenting problem, population, and retrieval purpose described in the query. Rank only the supplied documents; do not make clinical decisions.";

export type EvidenceRerankStatus = "ranked" | "disabled" | "not_configured" | "cancelled" | "timeout" | "invalid_response" | "upstream_error";
export type EvidenceRerankResult = {
  /** Original document indices, always a full permutation; failures preserve the input order. */
  order: number[];
  status: EvidenceRerankStatus;
  durationMs: number;
  model: typeof MODEL;
  usage?: { totalTokens: number };
};

function boundedUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let bounded = "";
  for (const character of text.trim().slice(0, maxBytes)) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maxBytes) break;
    bounded += character;
  }
  return bounded;
}

function allowedBailianOrigin(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.origin === new URL(ENDPOINT).origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseRanking(payload: unknown, documentCount: number): Pick<EvidenceRerankResult, "order" | "usage"> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.results) || record.results.length !== documentCount) return;
  const seen = new Set<number>();
  const scores: Array<{ index: number; score: number }> = [];
  for (const value of record.results) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const { index, relevance_score: score } = value as Record<string, unknown>;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= documentCount || seen.has(index)) return;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) return;
    seen.add(index);
    scores.push({ index, score });
  }
  const usage = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
    ? (record.usage as Record<string, unknown>).total_tokens : undefined;
  return {
    order: scores.sort((left, right) => right.score - left.score || left.index - right.index).map(item => item.index),
    ...(typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0 ? { usage: { totalTokens: usage } } : {}),
  };
}

/**
 * Optional ordering of an already-admitted evidence pool; callers must sanitize the clinical query
 * and document text before calling. No raw text is retained or logged. Fewer than two documents
 * return `disabled`; invalid input or oversized pools also skip the request without dropping items.
 * timeoutMs is an in-process override clamped to 100–3000 ms, including response-body consumption.
 */
export async function rerankEvidenceDocuments(
  query: string,
  documents: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EvidenceRerankResult> {
  const started = performance.now();
  const originalOrder = documents.map((_, index) => index);
  const enabled = process.env.EVIDENCE_RERANK_ENABLED === "true";
  const finish = (status: EvidenceRerankStatus, ranking?: Pick<EvidenceRerankResult, "order" | "usage">): EvidenceRerankResult => {
    const result = { order: originalOrder, ...ranking, status, durationMs: Math.round(performance.now() - started), model: MODEL };
    if (enabled) console.info("[tcm-cdss:telemetry] evidence_rerank", {
      status, durationMs: result.durationMs, documentCount: documents.length, model: MODEL,
      ...(ranking?.usage ? { totalTokens: ranking.usage.totalTokens } : {}),
    });
    return result;
  };
  if (options.signal?.aborted) return finish("cancelled");
  if (!enabled || documents.length < 2) return finish("disabled");
  const config = getBailianQwenConfig();
  // A permissive text-model host override must not export the Bailian credential to rerank hosts.
  if (!config.configured || !allowedBailianOrigin(config.baseUrl)) return finish("not_configured");
  if (documents.length > MAX_DOCUMENTS || typeof query !== "string" || documents.some(document => typeof document !== "string")) return finish("disabled");
  const safeQuery = boundedUtf8(query, 2048);
  const safeDocuments = documents.map(document => boundedUtf8(document, 4096));
  if (!safeQuery || safeDocuments.some(document => !document)) return finish("disabled");

  const requestedTimeout = options.timeoutMs;
  const timeoutMs = typeof requestedTimeout === "number" && Number.isFinite(requestedTimeout)
    ? Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.round(requestedTimeout))) : MAX_TIMEOUT_MS;
  const remainingMs = timeoutMs - (performance.now() - started);
  if (remainingMs <= 0) return finish("timeout");
  const controller = new AbortController();
  let interruption: "cancelled" | "timeout" | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;
  type Outcome = { status: EvidenceRerankStatus; ranking?: Pick<EvidenceRerankResult, "order" | "usage"> };
  const interrupted = new Promise<Outcome>(resolve => {
    const stop = (status: "cancelled" | "timeout") => {
      if (interruption) return;
      interruption = status;
      controller.abort();
      resolve({ status });
    };
    onParentAbort = () => stop("cancelled");
    options.signal?.addEventListener("abort", onParentAbort, { once: true });
    timer = setTimeout(() => stop("timeout"), remainingMs);
  });
  const request = async (): Promise<Outcome> => {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: MODEL, query: safeQuery, documents: safeDocuments, top_n: documents.length, instruct: INSTRUCTION }),
      });
      if (interruption || !response.ok || response.redirected) {
        void cancelResponseBody(response);
        return { status: interruption ?? "upstream_error" };
      }
      // The abortable pipe propagates cancellation to the upstream reader during a stalled body.
      // The outer race also settles if an adapter ignores AbortSignal or never resolves cleanup.
      const readable = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: controller.signal });
      const raw = await readResponseTextLimited(new Response(readable ?? null, { headers: response.headers }), MAX_RESPONSE_BYTES);
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { return { status: "invalid_response" }; }
      const ranking = parseRanking(payload, documents.length);
      return ranking ? { status: "ranked", ranking } : { status: "invalid_response" };
    } catch (error) {
      return { status: interruption ?? (error instanceof UpstreamResponseTooLargeError ? "invalid_response" : "upstream_error") };
    }
  };
  try {
    const outcome = await Promise.race([request(), interrupted]);
    return finish(outcome.status, outcome.ranking);
  } finally {
    clearTimeout(timer);
    if (onParentAbort) options.signal?.removeEventListener("abort", onParentAbort);
  }
}
