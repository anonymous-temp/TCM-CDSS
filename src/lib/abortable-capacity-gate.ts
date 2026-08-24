export type CapacityLease = () => void;

type QueuedAcquire = {
  grant: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  fairnessKey?: string;
};

export type CapacityGate = {
  acquire: (options?: { signal?: AbortSignal; deadline?: number; fairnessKey?: string }) => Promise<CapacityLease>;
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
  const fairnessOrder: string[] = [];
  const UNKEYED_FAIRNESS_KEY = "\0unkeyed";
  let active = 0;
  let lastGrantedFairnessKey: string | undefined;

  const queueKey = (entry: Pick<QueuedAcquire, "fairnessKey">) =>
    entry.fairnessKey ?? UNKEYED_FAIRNESS_KEY;

  const removeFairnessKeyIfEmpty = (key: string) => {
    if (queue.some((entry) => !entry.settled && queueKey(entry) === key)) return;
    const index = fairnessOrder.indexOf(key);
    if (index >= 0) fairnessOrder.splice(index, 1);
  };

  const removeQueued = (entry: QueuedAcquire) => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    removeFairnessKeyIfEmpty(queueKey(entry));
  };

  const cleanup = (entry: QueuedAcquire) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort!);
  };

  const grantNext = () => {
    while (active < normalizedLimit && queue.length > 0) {
      if (fairnessOrder.length > 1 && fairnessOrder[0] === (lastGrantedFairnessKey ?? UNKEYED_FAIRNESS_KEY)) {
        fairnessOrder.push(fairnessOrder.shift()!);
      }
      const key = fairnessOrder.shift();
      if (!key) break;
      const fairIndex = queue.findIndex((candidate) => !candidate.settled && queueKey(candidate) === key);
      if (fairIndex < 0) continue;
      const entry = queue.splice(fairIndex, 1)[0]!;
      if (queue.some((candidate) => !candidate.settled && queueKey(candidate) === key)) {
        fairnessOrder.push(key);
      }
      lastGrantedFairnessKey = entry.fairnessKey;
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
    const { signal, deadline, fairnessKey } = options;
    if (signal?.aborted) throw new Error("capacity_wait_aborted");
    if (deadline != null && deadline <= Date.now()) throw new Error("capacity_wait_deadline");
    if (active < normalizedLimit && queue.length === 0) {
      active += 1;
      lastGrantedFairnessKey = fairnessKey;
      return lease();
    }

    return new Promise<CapacityLease>((resolve, reject) => {
      const entry: QueuedAcquire = {
        settled: false,
        signal,
        fairnessKey,
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
      const key = queueKey(entry);
      if (!fairnessOrder.includes(key)) fairnessOrder.push(key);
    });
  };

  return {
    acquire,
    snapshot: () => ({ active, queued: queue.filter((entry) => !entry.settled).length, limit: normalizedLimit }),
  };
}
