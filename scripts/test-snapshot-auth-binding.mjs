import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { createJiti } from "jiti";

process.env.NODE_ENV = "production";
process.env.CDSS_REQUIRE_API_AUTH = "true";
process.env.CASE_SNAPSHOT_ENCRYPTION_KEY = "snapshot-test-encryption-key-not-for-production";
process.env.CDSS_API_CLIENT_ID = "snapshot-test-client";
process.env.CDSS_API_CUSTOMER_IDS = "snapshot-customer-a,snapshot-customer-b";

const accessTokenA = "snapshot-test-access-token-a-not-for-production";
const accessTokenB = "snapshot-test-access-token-b-not-for-production";
process.env.CDSS_API_TOKEN = accessTokenA;

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { POST } = await jiti.import("../src/app/api/diagnosis/snapshot/route.ts");
const {
  CDSS_UI_COOKIE,
  CDSS_UI_COOKIE_MAX_AGE_SECONDS,
  cdssUiCookieValue,
} = await jiti.import("../src/lib/cdss-auth.ts");

const bindingA = "a".repeat(64);
const bindingB = "b".repeat(64);
const payload = { patientId: "snapshot-relogin-test", marker: "plaintext-must-not-leak" };
const failures = [];
let cases = 0;

async function test(name, run) {
  cases += 1;
  try {
    await run();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function snapshotRequest(body, auth = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-cdss-customer-id", auth.customerId || "snapshot-customer-a");
  if (auth.cookie) headers.set("cookie", `${CDSS_UI_COOKIE}=${auth.cookie}`);
  if (auth.token) headers.set("x-cdss-api-token", auth.token);
  return new Request("http://localhost/api/diagnosis/snapshot", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function callSnapshot(body, auth) {
  const response = await POST(snapshotRequest(body, auth));
  return { response, text: await response.text() };
}

function parsed(text) {
  return JSON.parse(text);
}

function preTenantV1Envelope(value, binding, accessToken) {
  const key = createHash("sha256").update(process.env.CASE_SNAPSHOT_ENCRYPTION_KEY).digest();
  const scopeKey = createHmac("sha256", key).update("tcm-cdss-snapshot-scope-key-v1").digest();
  const authScope = createHmac("sha256", scopeKey)
    .update("tcm-cdss-snapshot-access-token-v1")
    .update("\0")
    .update(accessToken)
    .digest();
  const bindingHash = createHash("sha256").update(binding.toLowerCase()).digest();
  const aad = Buffer.concat([
    Buffer.from("tcm-cdss-workspace-v2", "utf8"),
    Buffer.from([0]),
    bindingHash,
    Buffer.from([0]),
    authScope,
  ]);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
  return {
    schemaVersion: "tcm-cdss-encrypted-snapshot-v1",
    algorithm: "A256GCM",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    updatedAt: new Date().toISOString(),
  };
}

const cookieA1 = await cdssUiCookieValue(accessTokenA, Date.now());
const cookieA2 = await cdssUiCookieValue(accessTokenA, Date.now() + 1_000);
assert.notEqual(cookieA1, cookieA2, "test setup must use distinct login cookies");

let envelopeA;
await test("encrypts without exposing credentials or plaintext", async () => {
  const result = await callSnapshot({ action: "encrypt", binding: bindingA, payload }, { cookie: cookieA1 });
  assert.equal(result.response.status, 200);
  assert.equal(result.text.includes(accessTokenA), false);
  assert.equal(result.text.includes(cookieA1), false);
  assert.equal(result.text.includes(payload.marker), false);
  envelopeA = parsed(result.text).envelope;
  assert.ok(envelopeA);
  assert.equal(envelopeA.schemaVersion, "tcm-cdss-encrypted-snapshot-v2", "新保存必须写 v2 租户绑定信封");
});
assert.ok(envelopeA, "snapshot A fixture must be created before isolation checks");

await test("restores a pre-tenant v1 envelope and marks it for v2 rewrite", async () => {
  const legacyPayload = { patientId: "legacy-pre-tenant", marker: "legacy-recovered" };
  const legacyEnvelope = preTenantV1Envelope(legacyPayload, bindingA, accessTokenA);
  const result = await callSnapshot(
    { action: "decrypt", binding: bindingA, envelope: legacyEnvelope },
    { cookie: cookieA1, customerId: "snapshot-customer-a" },
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(parsed(result.text).payload, legacyPayload);
  assert.equal(parsed(result.text).legacyEnvelope, true);
});

await test("never applies the v1 fallback to a v2 envelope from another customer", async () => {
  const result = await callSnapshot(
    { action: "decrypt", binding: bindingA, envelope: envelopeA },
    { cookie: cookieA1, customerId: "snapshot-customer-b" },
  );
  assert.equal(result.response.status, 400);
});

await test("restores after a new login cookie is issued", async () => {
  const result = await callSnapshot({ action: "decrypt", binding: bindingA, envelope: envelopeA }, { cookie: cookieA2 });
  assert.equal(result.response.status, 200);
  assert.deepEqual(parsed(result.text).payload, payload);
});

await test("maps API-token and UI-cookie authentication to the same stable scope", async () => {
  const result = await callSnapshot({ action: "decrypt", binding: bindingA, envelope: envelopeA }, { token: accessTokenA });
  assert.equal(result.response.status, 200);
  assert.deepEqual(parsed(result.text).payload, payload);
});

await test("rejects a different workspace binding", async () => {
  const result = await callSnapshot({ action: "decrypt", binding: bindingB, envelope: envelopeA }, { cookie: cookieA2 });
  assert.equal(result.response.status, 400);
});

await test("rejects tampered ciphertext", async () => {
  const replacement = envelopeA.ciphertext.startsWith("A") ? "B" : "A";
  const tampered = { ...envelopeA, ciphertext: `${replacement}${envelopeA.ciphertext.slice(1)}` };
  const result = await callSnapshot({ action: "decrypt", binding: bindingA, envelope: tampered }, { cookie: cookieA2 });
  assert.equal(result.response.status, 400);
});

await test("requires an authenticated session", async () => {
  const result = await callSnapshot({ action: "decrypt", binding: bindingA, envelope: envelopeA });
  assert.equal(result.response.status, 401);
  assert.equal(result.text.includes(accessTokenA), false);
});

await test("rejects an incorrect API token as unauthorized", async () => {
  const result = await callSnapshot({ action: "decrypt", binding: bindingA, envelope: envelopeA }, { token: accessTokenB });
  assert.equal(result.response.status, 401);
  assert.equal(result.text.includes(accessTokenB), false);
});

await test("rejects a cookie signed for a different access-token scope", async () => {
  const wrongScopeCookie = await cdssUiCookieValue(accessTokenB);
  const result = await callSnapshot({ action: "decrypt", binding: bindingA, envelope: envelopeA }, { cookie: wrongScopeCookie });
  assert.equal(result.response.status, 401);
  assert.equal(result.text.includes(wrongScopeCookie), false);
});

await test("treats cookie expiry only as session expiry", async () => {
  const expiredAt = Date.now() - (CDSS_UI_COOKIE_MAX_AGE_SECONDS + 5) * 1_000;
  const expiredCookie = await cdssUiCookieValue(accessTokenA, expiredAt);
  const expiredResult = await callSnapshot(
    { action: "decrypt", binding: bindingA, envelope: envelopeA },
    { cookie: expiredCookie },
  );
  assert.equal(expiredResult.response.status, 401);

  const freshCookie = await cdssUiCookieValue(accessTokenA);
  const freshResult = await callSnapshot(
    { action: "decrypt", binding: bindingA, envelope: envelopeA },
    { cookie: freshCookie },
  );
  assert.equal(freshResult.response.status, 200);
  assert.deepEqual(parsed(freshResult.text).payload, payload);
});

let envelopeB;
await test("isolates snapshots after access-token rotation", async () => {
  process.env.CDSS_API_TOKEN = accessTokenB;
  const cookieB = await cdssUiCookieValue(accessTokenB);
  const oldResult = await callSnapshot(
    { action: "decrypt", binding: bindingA, envelope: envelopeA },
    { cookie: cookieB },
  );
  assert.equal(oldResult.response.status, 400);
  assert.equal(oldResult.text.includes(accessTokenA), false);
  assert.equal(oldResult.text.includes(accessTokenB), false);

  const newResult = await callSnapshot(
    { action: "encrypt", binding: bindingA, payload: { patientId: "token-b-scope" } },
    { cookie: cookieB },
  );
  assert.equal(newResult.response.status, 200);
  envelopeB = parsed(newResult.text).envelope;
  assert.ok(envelopeB);
});

await test("prevents an old access-token scope from decrypting new snapshots", async () => {
  process.env.CDSS_API_TOKEN = accessTokenA;
  assert.ok(envelopeB, "snapshot B fixture must be created before reverse isolation check");
  const freshCookieA = await cdssUiCookieValue(accessTokenA);
  const result = await callSnapshot(
    { action: "decrypt", binding: bindingA, envelope: envelopeB },
    { cookie: freshCookieA },
  );
  assert.equal(result.response.status, 400);
});

process.env.CDSS_API_TOKEN = accessTokenA;

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ cases, failures: 0 }));
}
