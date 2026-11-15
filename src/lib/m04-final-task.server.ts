import "server-only";
import { sanitizeUnknownForModel } from "./diagnosis-safety";
import type { M04FinalContentIO, M04Task } from "./m04-final-content-types";

/** A deadline really bounds waiting, even when an injected provider ignores abort.
 * No shared cache here: failures and caller aborts cannot poison another request. */
export async function callFinalM04Task(io: M04FinalContentIO, task: M04Task, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  if (!io.call || signal?.aborted || timeoutMs <= 0) return undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const unavailable = new Promise<undefined>((resolve) => {
    abort = () => { controller.abort(); resolve(undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, timeoutMs);
  });
  try {
    const safe = sanitizeUnknownForModel(structuredClone(payload), { patientName: io.patientName, maxStringLength: 20_000, maxDepth: 16, preserveSchemaKeys: true });
    return await Promise.race([Promise.resolve().then(() => io.call!(task, safe, controller.signal)).catch(() => undefined), unavailable]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
