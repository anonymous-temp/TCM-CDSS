export function rejectLargeRequest(req: Request, maxBytes: number): Response | null {
  const rawLength = req.headers.get("content-length");
  if (!rawLength) return null;
  const length = Number(rawLength);
  if (!Number.isFinite(length) || length <= maxBytes) return null;
  return Response.json({ error: `Request body too large; limit is ${maxBytes} bytes` }, { status: 413 });
}

export async function readJsonBodyWithLimit(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const tooLarge = rejectLargeRequest(req, maxBytes);
  if (tooLarge) return { ok: false, response: tooLarge };
  if (!req.body) return { ok: false, response: Response.json({ error: "Invalid JSON body" }, { status: 400 }) };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: Response.json({ error: `Request body too large; limit is ${maxBytes} bytes` }, { status: 413 }) };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const text = new TextDecoder().decode(concatChunks(chunks, received));
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: Response.json({ error: "Invalid JSON body" }, { status: 400 }) };
  }
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
