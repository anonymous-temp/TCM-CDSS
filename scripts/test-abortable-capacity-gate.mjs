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

const fairGate = createAbortableCapacityGate(1);
const fairHeld = await fairGate.acquire({ fairnessKey: "tenant-root" });
const fairOrder = [];
const tenantA1 = fairGate.acquire({ fairnessKey: "tenant-a" }).then((release) => { fairOrder.push("a1"); return release; });
const tenantA2 = fairGate.acquire({ fairnessKey: "tenant-a" }).then((release) => { fairOrder.push("a2"); return release; });
const tenantB1 = fairGate.acquire({ fairnessKey: "tenant-b" }).then((release) => { fairOrder.push("b1"); return release; });
fairHeld();
const releaseA1 = await tenantA1;
releaseA1();
const releaseB1 = await tenantB1;
assert.deepEqual(fairOrder, ["a1", "b1"], "a busy tenant must not monopolize the next queued grant");
releaseB1();
const releaseA2 = await tenantA2;
releaseA2();

const roundRobinGate = createAbortableCapacityGate(1);
const roundRobinHeld = await roundRobinGate.acquire({ fairnessKey: "tenant-a" });
const roundRobinOrder = [];
const queuedByTenant = Object.fromEntries([
  ["a1", "tenant-a"], ["a2", "tenant-a"], ["a3", "tenant-a"],
  ["b1", "tenant-b"], ["b2", "tenant-b"], ["b3", "tenant-b"],
  ["c1", "tenant-c"],
].map(([label, fairnessKey]) => [
  label,
  roundRobinGate.acquire({ fairnessKey }).then((release) => {
    roundRobinOrder.push(label);
    return release;
  }),
]));
roundRobinHeld();
for (const label of ["b1", "c1", "a1", "b2", "a2", "b3", "a3"]) {
  const release = await queuedByTenant[label];
  assert.equal(roundRobinOrder.at(-1), label,
    "round-robin admission must give every queued tenant a turn before returning to a busy bucket");
  release();
}
assert.deepEqual(roundRobinOrder, ["b1", "c1", "a1", "b2", "a2", "b3", "a3"]);

console.log(JSON.stringify({ cases: 17, failures: 0 }));
