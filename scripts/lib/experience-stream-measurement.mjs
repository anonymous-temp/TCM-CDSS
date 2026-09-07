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
  let moduleDraftCount = 0, clinicalDraftCount = 0, firstModuleMs = null;
  // These are the exact legacy protocol status copies, not a clinical-language classifier.
  const progressCopies = new Set(["西医判断已生成，正在校验。", "中医辨病辨证已生成，正在校验。", "病机分析已生成，正在校验。", "治则治法已生成，正在校验。"]);
  const containsClinicalDraft = (value) => {
    const body = value.split("\n").filter(line => line.trim() && !line.trimStart().startsWith(">") && !line.trimStart().startsWith("#")).join("\n").trim();
    return Boolean(body && !progressCopies.has(body));
  };
  const visibleBody = (value) => value.replaceAll("<<<CDSS_STREAM_FINAL>>>", "").split("<!-- DIAGNOSIS_JSON_START -->")[0].trim();
  const hasBodyText = (value) => /[\p{L}\p{N}]/u.test(visibleBody(value)) && !/^[{[]/.test(visibleBody(value));
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
        firstModuleMs ??= elapsed();
        if (containsClinicalDraft(frame.content)) {
          clinicalDraftCount++;
          firstUsefulMs ??= elapsed();
        }
      }
      return;
    }
    if (frame.type) return; // Heartbeats and optional metadata are never clinical content.
    if (frame.content === "[END]") {
      ended = true;
      // Unstructured stages have no module frames; complete delivery is the conservative bound.
      if (hasBodyText(content) && !streamError) firstUsefulMs ??= elapsed();
      return;
    }
    if (typeof frame.content !== "string" || !frame.content) return;
    content += frame.content;
    firstContentMs ??= elapsed();
    const marker = "<<<CDSS_STREAM_FINAL>>>";
    if (frame.content.startsWith(marker) && hasBodyText(frame.content)) {
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
  return { raw, content, ended, streamError, firstByteMs, firstContentMs, firstUsefulMs, firstModuleMs, moduleDraftCount, clinicalDraftCount, durationMs: elapsed() };
}
