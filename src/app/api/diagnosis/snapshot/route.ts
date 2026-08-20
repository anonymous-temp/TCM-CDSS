import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { isEncryptedSnapshotEnvelope, type EncryptedSnapshotEnvelope } from "@/lib/encrypted-snapshot";
import {
  bearerToken,
  CDSS_UI_COOKIE,
  getCdssAccessToken,
  isCdssAuthRequired,
  isValidCdssUiCookieValue,
  sameSecret,
} from "@/lib/cdss-auth";
import { requireCustomerContext } from "@/lib/customer-context";

export const runtime = "nodejs";

const SNAPSHOT_AAD_PREFIX = "tcm-cdss-workspace-v2";
const SNAPSHOT_SCOPE_KEY_CONTEXT = "tcm-cdss-snapshot-scope-key-v1";
const SNAPSHOT_ACCESS_SCOPE_CONTEXT = "tcm-cdss-snapshot-access-token-v1";
const SNAPSHOT_DEV_SCOPE_CONTEXT = "tcm-cdss-snapshot-dev-unauthenticated-v1";
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 3 * 1024 * 1024;

type SnapshotAuthorization =
  | { ok: true; scope: Buffer }
  | { ok: false; status: 401 | 503; error: string };

function encryptionKey(): Buffer | undefined {
  const secret = process.env.CASE_SNAPSHOT_ENCRYPTION_KEY || "";
  return secret.length >= 16 ? createHash("sha256").update(secret).digest() : undefined;
}

function requestCookie(req: Request, name: string): string {
  const prefix = `${name}=`;
  return (req.headers.get("cookie") || "")
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length) || "";
}

function stableSnapshotScope(key: Buffer, accessIdentity: string): Buffer {
  const scopeKey = createHmac("sha256", key).update(SNAPSHOT_SCOPE_KEY_CONTEXT).digest();
  return createHmac("sha256", scopeKey)
    .update(SNAPSHOT_ACCESS_SCOPE_CONTEXT)
    .update("\0")
    .update(accessIdentity)
    .digest();
}

async function authorizeSnapshot(req: Request, key: Buffer): Promise<SnapshotAuthorization> {
  if (!isCdssAuthRequired()) {
    return { ok: true, scope: stableSnapshotScope(key, SNAPSHOT_DEV_SCOPE_CONTEXT) };
  }

  const expectedToken = getCdssAccessToken();
  if (expectedToken.length < 16) {
    return { ok: false, status: 503, error: "病例快照访问凭据未安全配置" };
  }

  const uiCookie = requestCookie(req, CDSS_UI_COOKIE);
  const apiToken = req.headers.get("x-cdss-api-token")?.trim() || bearerToken(req.headers.get("authorization"));
  const tokenAuthenticated = sameSecret(apiToken, expectedToken);
  const cookieAuthenticated = Boolean(uiCookie) && await isValidCdssUiCookieValue(uiCookie, expectedToken);
  if (!tokenAuthenticated && !cookieAuthenticated) {
    return { ok: false, status: 401, error: "未授权的病例快照请求" };
  }

  // Login cookies are short-lived session proof only. The server-configured access credential
  // supplies the stable, tenant-scoped identity so a fresh valid login can restore prior saves.
  return { ok: true, scope: stableSnapshotScope(key, expectedToken) };
}

function snapshotAad(binding: unknown, authScope: Buffer): Buffer | undefined {
  if (typeof binding !== "string" || !/^[a-f0-9]{64}$/i.test(binding)) return undefined;
  const bindingHash = createHash("sha256").update(binding.toLowerCase()).digest();
  return Buffer.concat([
    Buffer.from(SNAPSHOT_AAD_PREFIX, "utf8"),
    Buffer.from([0]),
    bindingHash,
    Buffer.from([0]),
    authScope,
  ]);
}

function decryptSnapshotEnvelope(
  envelope: EncryptedSnapshotEnvelope,
  key: Buffer,
  aad: Buffer,
): unknown {
  const iv = Buffer.from(envelope.iv, "base64");
  const authTag = Buffer.from(envelope.authTag, "base64");
  if (iv.byteLength !== 12 || authTag.byteLength !== 16) throw new Error("invalid_envelope_lengths");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  if (plaintext.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("snapshot_too_large");
  return JSON.parse(plaintext.toString("utf8"));
}

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readLimitedJson(req: Request): Promise<{ value?: unknown; tooLarge?: boolean }> {
  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return { tooLarge: true };
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {};
  } finally {
    reader.releaseLock();
  }
}

export async function POST(req: Request) {
  const customer = await requireCustomerContext(req);
  if (!customer.ok) return customer.response;
  const key = encryptionKey();
  if (!key) return jsonResponse({ ok: false, error: "病例快照加密密钥未配置" }, 503);
  const authorization = await authorizeSnapshot(req, key);
  if (!authorization.ok) {
    return jsonResponse({ ok: false, error: authorization.error }, authorization.status);
  }
  const parsedBody = await readLimitedJson(req);
  if (parsedBody.tooLarge) return jsonResponse({ ok: false, error: "病例快照请求超过大小限制" }, 413);
  const body = parsedBody.value as { action?: unknown; payload?: unknown; envelope?: unknown; binding?: unknown } | null;
  if (!body || (body.action !== "encrypt" && body.action !== "decrypt")) {
    return jsonResponse({ ok: false, error: "无效的病例快照请求" }, 400);
  }
  const tenantScope = createHmac("sha256", authorization.scope)
    .update(customer.context.customerHash)
    .digest();
  const tenantAad = snapshotAad(body.binding, tenantScope);
  if (!tenantAad) return jsonResponse({ ok: false, error: "病例快照缺少有效的工作区绑定" }, 400);

  if (body.action === "encrypt") {
    const plaintext = Buffer.from(JSON.stringify(body.payload ?? null), "utf8");
    if (plaintext.byteLength > MAX_SNAPSHOT_BYTES) return jsonResponse({ ok: false, error: "病例快照超过大小限制" }, 413);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(tenantAad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedSnapshotEnvelope = {
      schemaVersion: "tcm-cdss-encrypted-snapshot-v2",
      algorithm: "A256GCM",
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      updatedAt: new Date().toISOString(),
    };
    return jsonResponse({ ok: true, envelope });
  }

  if (!isEncryptedSnapshotEnvelope(body.envelope)) {
    return jsonResponse({ ok: false, error: "无效的加密病例快照" }, 400);
  }
  try {
    if (body.envelope.schemaVersion === "tcm-cdss-encrypted-snapshot-v2") {
      return jsonResponse({ ok: true, payload: decryptSnapshotEnvelope(body.envelope, key, tenantAad) });
    }
    try {
      return jsonResponse({
        ok: true,
        payload: decryptSnapshotEnvelope(body.envelope, key, tenantAad),
        legacyEnvelope: true,
      });
    } catch {
      // Pre-tenant v1 snapshots were bound to the stable authenticated access scope only. The
      // fallback is deliberately restricted to v1 envelopes; a v2 tenant-bound envelope can never
      // escape into this branch after a customer mismatch or authentication failure.
      const legacyAad = snapshotAad(body.binding, authorization.scope);
      if (!legacyAad) throw new Error("invalid_legacy_aad");
      return jsonResponse({
        ok: true,
        payload: decryptSnapshotEnvelope(body.envelope, key, legacyAad),
        legacyEnvelope: true,
      });
    }
  } catch {
    return jsonResponse({ ok: false, error: "病例快照校验失败，已拒绝恢复" }, 400);
  }
}
