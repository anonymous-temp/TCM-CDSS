/** Passive NDJSON observer: never changes server behavior or logs request content. */
export async function measureExperienceResponse(response, { startedAt = performance.now(), now = () => performance.now(), streamed = true } = {}) {
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));
  if (!streamed) return { raw: await response.text(), durationMs: elapsed() };
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response has no readable body");
  const decoder = new TextDecoder();
  let raw = "", pending = "", content = "";
  let ended = false, streamError = false;
  let firstByteMs = null, firstContentMs = null, firstUsefulMs = null;
  let moduleDraftCount = 0;
  const moduleIds = new Set(["m03.western", "m03.syndrome", "m03.pathogenesis", "m03.therapy", "m04.candidate"]);
  const parseLine = (line) => {
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch { streamError = true; return; }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) { streamError = true; return; }
    if (frame.error) streamError = true;
    if (frame.type === "module_draft") {
      if (moduleIds.has(frame.module) && Number.isInteger(frame.revision) && frame.revision > 0
        && typeof frame.content === "string" && frame.content.trim() && frame.content.length <= 8000) {
        moduleDraftCount++;
        firstUsefulMs ??= elapsed();
      }
      return;
    }
    if (frame.type) return; // Heartbeats and optional metadata are never clinical content.
    if (frame.content === "[END]") {
      ended = true;
      // Unstructured stages have no module frames; complete delivery is the conservative bound.
      if (content.trim() && !streamError) firstUsefulMs ??= elapsed();
      return;
    }
    if (typeof frame.content !== "string" || !frame.content) return;
    content += frame.content;
    firstContentMs ??= elapsed();
    const marker = "<<<CDSS_STREAM_FINAL>>>";
    if (frame.content.startsWith(marker) && frame.content.slice(marker.length).split("<!-- DIAGNOSIS_JSON_START -->")[0].trim()) {
      firstUsefulMs ??= elapsed();
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.length) firstByteMs ??= elapsed();
      const text = decoder.decode(value, { stream: true });
      raw += text;
      pending += text;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        parseLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    const tail = decoder.decode();
    raw += tail;
    pending += tail;
    if (pending.trim()) parseLine(pending);
  } finally {
    reader.releaseLock();
  }
  return { raw, content, ended, streamError, firstByteMs, firstContentMs, firstUsefulMs, moduleDraftCount, durationMs: elapsed() };
}
