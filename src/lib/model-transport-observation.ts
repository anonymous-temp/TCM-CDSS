import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type TransportObservation = { callId: string; attempts: number; observed: boolean };
const observation = new AsyncLocalStorage<TransportObservation>();

/** Per logical call, including concurrent SDK calls; no request bodies, URLs or headers retained. */
export function observeModelTransport<T>(run: (state: TransportObservation) => Promise<T>): Promise<T> {
  const state = { callId: randomUUID(), attempts: 0, observed: false };
  return observation.run(state, () => run(state));
}

/** SDK retries pass through this wrapper individually. Never read or log the request. */
export const observedModelFetch: typeof fetch = (input, init) => {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  signal?.throwIfAborted();
  const state = observation.getStore();
  if (state) {
    state.observed = true;
    state.attempts += 1;
  }
  return globalThis.fetch(input, init);
};
