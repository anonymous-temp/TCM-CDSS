export function rejectLargeRequest(req: Request, maxBytes: number): Response | null {
  const rawLength = req.headers.get("content-length");
  if (!rawLength) return null;
  const length = Number(rawLength);
  if (!Number.isFinite(length) || length <= maxBytes) return null;
  return Response.json({ error: `Request body too large; limit is ${maxBytes} bytes` }, { status: 413 });
}

/**
 * 请求体压缩（2026-09-27，提速）。M04/M05 的请求体要原样回传上一阶段的正文与签名结论，
 * 实测 M05 约 140–170KB、M04 约 50–60KB；从外网到生产主机的上行只有几十 KB/s，
 * 光上传就占 M05 客户端耗时的一半（本机实测：服务端 3.4–4.4s，客户端 7.8–8.7s）。
 * 这类中文 JSON 用 gzip 压到约 1/5，所以请求可选 `Content-Encoding: gzip`（或 deflate）；
 * 不带该头时行为与原来逐字相同。
 *
 * 上限口径：解压后的 JSON 字节数与压缩前的传输字节数都不得超过 maxBytes（后者挡住
 * 「无限个空 gzip 成员」这种解压后很小、传输无限长的流）；解压失败按 400，未知编码按 415。
 */
const SUPPORTED_REQUEST_ENCODINGS = new Set(["gzip", "deflate"]);

class RequestBodyTooLargeError extends Error {}

function requestBodyTooLarge(maxBytes: number): Response {
  return Response.json({ error: `Request body too large; limit is ${maxBytes} bytes` }, { status: 413 });
}

/** null = 未压缩；undefined = 不支持的编码。 */
function requestContentEncoding(req: Request): "gzip" | "deflate" | null | undefined {
  const raw = req.headers.get("content-encoding")?.trim().toLowerCase();
  if (!raw || raw === "identity") return null;
  return SUPPORTED_REQUEST_ENCODINGS.has(raw) ? raw as "gzip" | "deflate" : undefined;
}

export async function readJsonBodyWithLimit(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const tooLarge = rejectLargeRequest(req, maxBytes);
  if (tooLarge) return { ok: false, response: tooLarge };
  if (!req.body) return { ok: false, response: Response.json({ error: "Invalid JSON body" }, { status: 400 }) };
  const encoding = requestContentEncoding(req);
  if (encoding === undefined) {
    await req.body.cancel().catch(() => undefined);
    return { ok: false, response: Response.json({ error: "Unsupported Content-Encoding; send gzip, deflate or an uncompressed body" }, { status: 415 }) };
  }

  let source: ReadableStream<Uint8Array> = req.body;
  if (encoding) {
    let transferred = 0;
    const transferLimit = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        transferred += chunk.byteLength;
        if (transferred > maxBytes) controller.error(new RequestBodyTooLargeError());
        else controller.enqueue(chunk);
      },
    });
    source = req.body.pipeThrough(transferLimit).pipeThrough(new DecompressionStream(encoding) as unknown as TransformStream<Uint8Array, Uint8Array>);
  }

  const reader = source.getReader();
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
        return { ok: false, response: requestBodyTooLarge(maxBytes) };
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RequestBodyTooLargeError) return { ok: false, response: requestBodyTooLarge(maxBytes) };
    if (encoding) return { ok: false, response: Response.json({ error: "Invalid compressed body" }, { status: 400 }) };
    throw error;
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
