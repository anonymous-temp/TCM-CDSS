/** A shared M05 authoring request owns its timeout; individual outlets own only their wait. */
export type FollowupSharedWork<T> = {
  controller: AbortController;
  consumers: number;
  promise: Promise<T | null>;
};

export function consumeFollowupWork<T>(work: FollowupSharedWork<T>, signal?: AbortSignal): Promise<T | null> {
  if (signal?.aborted || work.controller.signal.aborted) return Promise.resolve(null);
  work.consumers += 1;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: T | null, canceled = false) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      work.consumers -= 1;
      if (canceled && work.consumers === 0) work.controller.abort();
      resolve(value);
    };
    const onAbort = () => finish(null, true);
    signal?.addEventListener("abort", onAbort, { once: true });
    work.promise.then((value) => finish(value), () => finish(null));
  });
}
