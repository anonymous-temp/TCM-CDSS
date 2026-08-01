import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const LOCAL_IMAGE = process.env.TONGUE_VISION_TEST_IMAGE || "";
const PUBLIC_FIXTURE_URL = process.env.TONGUE_VISION_TEST_IMAGE_URL ||
  "https://upload.wikimedia.org/wikipedia/commons/a/a0/Human_tongue_infected_with_oral_candidiasis.jpg";
const TIMEOUT_MS = Number(process.env.TONGUE_VISION_TEST_TIMEOUT_MS || 180_000);
const ARTIFACT_DIR = resolve(process.env.TONGUE_VISION_ARTIFACT_DIR || "artifacts/tongue-vision-live");

function mimeFor(name) {
  const extension = extname(name).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

async function fixture() {
  if (LOCAL_IMAGE) {
    return {
      bytes: readFileSync(LOCAL_IMAGE),
      mime: mimeFor(LOCAL_IMAGE),
      source: `local:${basename(LOCAL_IMAGE)}`,
    };
  }
  const response = await fetch(PUBLIC_FIXTURE_URL);
  assert.equal(response.ok, true, `public tongue fixture download failed: HTTP ${response.status}`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mime: response.headers.get("content-type")?.split(";")[0] || mimeFor(PUBLIC_FIXTURE_URL),
    source: PUBLIC_FIXTURE_URL,
  };
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
        ...init.headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function consumeNdjson(raw) {
  const frames = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(frames.some((frame) => typeof frame.error === "string"), false,
    `tongue stream returned an error: ${raw.slice(0, 600)}`);
  assert.equal(frames.filter((frame) => frame.content === "[END]").length, 1,
    `tongue stream must contain exactly one END frame: ${raw.slice(0, 600)}`);
  assert.equal(frames.at(-1)?.content, "[END]", "END must be the final tongue stream frame");
  return frames
    .filter((frame) => typeof frame.content === "string" && frame.content !== "[END]")
    .map((frame) => frame.content)
    .join("");
}

const healthResponse = await request("/api/diagnosis/health?strict=1");
assert.equal(healthResponse.ok, true, `strict health returned HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
assert.equal(health.providers?.tongueVision?.enabled, true, "tongue vision must be enabled");
assert.equal(health.providers?.tongueVision?.configured, true, "tongue vision key must be configured");
assert.equal(health.tongueVisionProbe?.ok, true,
  `real GLM multimodal probe failed: ${health.tongueVisionProbe?.reason || "unknown"}`);

const image = await fixture();
assert.ok(image.bytes.length > 64 && image.bytes.length <= 4_200_000,
  `fixture must be a supported image no larger than 4.2 MB; got ${image.bytes.length} bytes`);
const dataUrl = `data:${image.mime};base64,${image.bytes.toString("base64")}`;
const startedAt = Date.now();
const response = await request("/api/diagnosis/collect", {
  method: "POST",
  body: JSON.stringify({
    userInput: "本测试仅验证舌象图片质量与结构化抽取，不提供其他患者事实。",
    patientSex: "女",
    tongueImage: dataUrl,
    tongueImageConsent: true,
  }),
});
const raw = await response.text();
assert.equal(response.ok, true, `tongue collect returned HTTP ${response.status}: ${raw.slice(0, 600)}`);
const content = consumeNdjson(raw);
const sentinel = content.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/);
assert.ok(sentinel, "tongue collect must return the structured sentinel");
const structured = JSON.parse(sentinel[1]);
assert.equal(structured?.tongueDx?.schemaVersion, "tongue-dx-v1", "tongueDx schema version mismatch");
assert.equal(typeof structured?.tongueDx?.quality?.score, "number", "tongueDx quality score missing");
assert.equal(typeof structured?.tongueDx?.quality?.needRetake, "boolean", "tongueDx retake decision missing");
assert.ok(["supportive", "insufficient"].includes(structured?.tongueDx?.clinicalEvidenceLevel),
  "tongueDx evidence level must remain supportive or insufficient");
assert.equal(typeof structured?.tongueDx?.summaryText, "string", "tongueDx summary is missing");

mkdirSync(ARTIFACT_DIR, { recursive: true });
const result = {
  testedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  fixtureSource: image.source,
  fixtureBytes: image.bytes.length,
  elapsedMs: Date.now() - startedAt,
  probe: health.tongueVisionProbe,
  tongueDx: structured.tongueDx,
  failures: 0,
};
writeFileSync(resolve(ARTIFACT_DIR, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
