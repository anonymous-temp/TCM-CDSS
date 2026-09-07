import assert from "node:assert/strict";
import { measureExperienceResponse } from "./lib/experience-stream-measurement.mjs";

function fixture(frames) {
  let tick = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (tick === frames.length) return controller.close();
      controller.enqueue(new TextEncoder().encode(frames[tick++]));
    },
  }));
  return { response, clock: () => tick * 10 };
}

const progress = fixture([
  '{"type":"heartbeat","status":"正在生成"}\n',
  '{"content":"{"}\n',
  '{"type":"module_draft","module":"m03.western","revision":1,"content":"### 西医工作判断\\n头痛，病因待查"}\n',
  '{"content":"<<<CDSS_STREAM_FINAL>>>完整临床正文"}\n',
  '{"content":"[END]"}\n',
]);
const result = await measureExperienceResponse(progress.response, { startedAt: 0, now: progress.clock });
assert.equal(result.ended, true);
assert.equal(result.streamError, false);
assert.ok(result.firstUsefulMs > result.firstContentMs);
assert.ok(result.firstUsefulMs < result.durationMs);
assert.equal(result.moduleDraftCount, 1);
assert.ok(!result.content.includes("西医工作判断"), "draft frames must not pollute canonical content");

const onlyHeartbeat = fixture(['{"type":"heartbeat","status":"仍在工作"}\n']);
assert.equal((await measureExperienceResponse(onlyHeartbeat.response, { startedAt: 0, now: onlyHeartbeat.clock })).firstUsefulMs, null);
const failure = fixture(['{"error":"上游未完成"}\n', '{"content":"[END]"}\n']);
assert.equal((await measureExperienceResponse(failure.response, { startedAt: 0, now: failure.clock })).streamError, true);

const truncated = fixture(['{"content":"未完成正文"}\n']);
const incomplete = await measureExperienceResponse(truncated.response, { startedAt: 0, now: truncated.clock });
assert.equal(incomplete.ended, false);
assert.equal(incomplete.firstUsefulMs, null);
const broken = fixture(['{"type":"module_draft","module":"unknown","revision":0,"content":"假模块"}\n']);
assert.equal((await measureExperienceResponse(broken.response, { startedAt: 0, now: broken.clock })).firstUsefulMs, null);

const bytes = new TextEncoder().encode('{"content":"完整临床正文"}\n{"content":"[END]"}\n');
const response = new Response(new ReadableStream({ start(controller) {
  for (const value of bytes) controller.enqueue(new Uint8Array([value]));
  controller.close();
} }));
assert.equal((await measureExperienceResponse(response)).content, "完整临床正文");
console.log(JSON.stringify({ suite: "experience-stream-measurement", checks: 12, failures: 0 }));
