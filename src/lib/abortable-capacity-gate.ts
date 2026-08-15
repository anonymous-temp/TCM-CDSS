export type CapacityLease = () => void;

type QueuedAcquire = {
  grant: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
};

export type CapacityGate = {
  acquire: (options?: { signal?: AbortSignal; deadline?: number }) => Promise<CapacityLease>;
  snapshot: () => { active: number; queued: number; limit: number };
};

/**
 * Small FIFO gate for expensive, multi-call orchestration stages.
 *
 * Waiting is abortable and deadline-bound. A lease is idempotent so every stream completion,
 * cancellation and fail-closed timeout path may release defensively without over-admitting work.
 */
export function createAbortableCapacityGate(limit: number): CapacityGate {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
  const queue: QueuedAcquire[] = [];
  let active = 0;

  const removeQueued = (entry: QueuedAcquire) => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  };

  const cleanup = (entry: QueuedAcquire) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort!);
  };

  const grantNext = () => {
    while (active < normalizedLimit && queue.length > 0) {
      const entry = queue.shift()!;
      if (entry.settled) continue;
      entry.grant();
    }
  };

  const lease = (): CapacityLease => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      grantNext();
    };
  };

  const acquire: CapacityGate["acquire"] = async (options = {}) => {
    const { signal, deadline } = options;
    if (signal?.aborted) throw new Error("capacity_wait_aborted");
    if (deadline != null && deadline <= Date.now()) throw new Error("capacity_wait_deadline");
    if (active < normalizedLimit && queue.length === 0) {
      active += 1;
      return lease();
    }

    return new Promise<CapacityLease>((resolve, reject) => {
      const entry: QueuedAcquire = {
        settled: false,
        signal,
        reject,
        grant: () => {
          if (entry.settled) return;
          entry.settled = true;
          cleanup(entry);
          active += 1;
          resolve(lease());
        },
      };
      const rejectWaiting = (error: Error) => {
        if (entry.settled) return;
        entry.settled = true;
        removeQueued(entry);
        cleanup(entry);
        entry.reject(error);
        grantNext();
      };
      entry.onAbort = () => rejectWaiting(new Error("capacity_wait_aborted"));
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      if (deadline != null) {
        entry.timer = setTimeout(
          () => rejectWaiting(new Error("capacity_wait_deadline")),
          Math.max(1, deadline - Date.now()),
        );
      }
      queue.push(entry);
    });
  };

  return {
    acquire,
    snapshot: () => ({ active, queued: queue.filter((entry) => !entry.settled).length, limit: normalizedLimit }),
  };
}
