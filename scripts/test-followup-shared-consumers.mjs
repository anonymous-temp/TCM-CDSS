import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { consumeFollowupWork } = await jiti.import("../src/lib/m05-followup-shared-work.ts");

let finish;
const work = { controller: new AbortController(), consumers: 0, promise: new Promise((resolve) => { finish = resolve; }) };
const owner = new AbortController();
const joined = new AbortController();
const first = consumeFollowupWork(work, owner.signal);
const second = consumeFollowupWork(work, joined.signal);
owner.abort();
assert.equal(await first, null, "canceled owner must finish promptly");
assert.equal(work.controller.signal.aborted, false, "joined consumer still needs the upstream work");
finish({ lifestyle: "本例生活建议" });
assert.deepEqual(await second, { lifestyle: "本例生活建议" });
assert.equal(work.consumers, 0);

const allGone = { controller: new AbortController(), consumers: 0, promise: new Promise(() => {}) };
const a = new AbortController();
const b = new AbortController();
const one = consumeFollowupWork(allGone, a.signal);
const two = consumeFollowupWork(allGone, b.signal);
a.abort();
b.abort();
assert.deepEqual(await Promise.all([one, two]), [null, null]);
assert.equal(allGone.controller.signal.aborted, true, "no consumers should cancel upstream");

const failure = { controller: new AbortController(), consumers: 0, promise: Promise.resolve(null) };
assert.deepEqual(await Promise.all([consumeFollowupWork(failure), consumeFollowupWork(failure)]), [null, null], "shared failure returns once without retrying");
assert.equal(failure.consumers, 0);
console.log(JSON.stringify({ checks: 8, failures: 0 }));
