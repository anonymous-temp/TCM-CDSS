import assert from "node:assert/strict";

const { createAbortableCapacityGate } = await import("../src/lib/abortable-capacity-gate.ts");

const gate = createAbortableCapacityGate(1);
const first = await gate.acquire();
let secondGranted = false;
const secondPromise = gate.acquire().then((release) => {
  secondGranted = true;
  return release;
});
await Promise.resolve();
assert.equal(secondGranted, false, "a queued stage cannot exceed the configured provider capacity");
assert.deepEqual(gate.snapshot(), { active: 1, queued: 1, limit: 1 });
first();
const second = await secondPromise;
assert.equal(secondGranted, true);
assert.deepEqual(gate.snapshot(), { active: 1, queued: 0, limit: 1 });
second();
second();
assert.deepEqual(gate.snapshot(), { active: 0, queued: 0, limit: 1 }, "lease release must be idempotent");

const fifoGate = createAbortableCapacityGate(1);
const held = await fifoGate.acquire();
const order = [];
const queuedA = fifoGate.acquire().then((release) => { order.push("a"); return release; });
const queuedB = fifoGate.acquire().then((release) => { order.push("b"); return release; });
held();
const releaseA = await queuedA;
assert.deepEqual(order, ["a"], "queued stages must be admitted FIFO");
releaseA();
const releaseB = await queuedB;
assert.deepEqual(order, ["a", "b"]);
releaseB();

const abortGate = createAbortableCapacityGate(1);
const abortHeld = await abortGate.acquire();
const controller = new AbortController();
const aborted = abortGate.acquire({ signal: controller.signal }).then(
  () => "granted",
  (error) => error.message,
);
controller.abort();
assert.equal(await aborted, "capacity_wait_aborted");
assert.deepEqual(abortGate.snapshot(), { active: 1, queued: 0, limit: 1 });
abortHeld();

const deadlineGate = createAbortableCapacityGate(1);
const deadlineHeld = await deadlineGate.acquire();
const expired = deadlineGate.acquire({ deadline: Date.now() + 15 }).then(
  () => "granted",
  (error) => error.message,
);
assert.equal(await expired, "capacity_wait_deadline");
deadlineHeld();

console.log(JSON.stringify({ cases: 8, failures: 0 }));
