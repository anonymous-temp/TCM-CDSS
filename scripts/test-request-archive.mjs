// 临床请求内容留存（owner 2026-10-12：服务端留存请求内容，先不限时，合规已确认）。
//
// 钉住：只留临床路由（登录体里是接口 Token，绝不能落盘）、密文落盘（盘上搜不到病历原文）、写入端与
// 导出脚本往返一致（导出脚本要单独管道进容器跑，两边的密钥派生各写一份，必须由这里对齐）、篡改元数据解不开、
// 超上限停写不删、写失败/缺密钥不影响请求本身、缺省关闭而 compose 打开、每个临床路由都经过留存入口。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const failures = [];
let checks = 0;
const check = async (name, fn) => {
  checks += 1;
  try { await fn(); } catch (error) { failures.push({ name, message: String(error?.message || error).slice(0, 600) }); }
};

const SECRET = "request-archive-test-secret-0123456789abcdef";
process.env.CASE_SNAPSHOT_ENCRYPTION_KEY = SECRET;
delete process.env.CDSS_REQUEST_ARCHIVE;
delete process.env.CDSS_REQUEST_ARCHIVE_MAX_BYTES;

const archive = await jiti.import("../src/lib/request-archive.server.ts");
const { readJsonRequest } = await jiti.import("../src/lib/diagnosis-request.ts");
const exporter = await import("../scripts/request-archive-export.mjs");

const MARKER = "患者王某某，反复胃脘隐痛三月余";
const clinicalBody = { caseState: { id: "archive-case-1", chiefComplaint: MARKER, patient: { sex: "女", age: 52 } } };
const requestOf = (path, body, headers = {}) => new Request(`https://host.example${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-cdss-customer-id": "hospital-a", ...headers },
  body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
});
const freshDir = () => mkdtempSync(join(tmpdir(), "cdss-request-archive-"));
const linesIn = (dir) => readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean));
const material = () => exporter.requestArchiveKeyFromSecret(SECRET);
const enable = async (dir) => {
  await archive.requestArchiveIdle();
  process.env.CDSS_REQUEST_ARCHIVE = "true";
  process.env.CDSS_REQUEST_ARCHIVE_PATH = dir;
  delete process.env.CDSS_REQUEST_ARCHIVE_MAX_BYTES;
  archive.resetRequestArchiveStateForTests();
};
async function captureWarnings(fn) {
  const original = console.warn;
  const seen = [];
  console.warn = (tag, detail) => { if (String(tag).includes("request_archive")) seen.push(detail); };
  try { await fn(); } finally { console.warn = original; }
  return seen;
}

await check("缺省关闭：未设 CDSS_REQUEST_ARCHIVE 时临床请求不落盘", async () => {
  const dir = freshDir();
  delete process.env.CDSS_REQUEST_ARCHIVE;
  process.env.CDSS_REQUEST_ARCHIVE_PATH = dir;
  archive.resetRequestArchiveStateForTests();
  const parsed = await readJsonRequest(requestOf("/tcm-cdss/api/diagnosis/prescribe", clinicalBody));
  assert.equal(parsed.ok, true);
  await archive.archiveClinicalRequest(requestOf("/tcm-cdss/api/diagnosis/prescribe", clinicalBody), clinicalBody);
  assert.deepEqual(readdirSync(dir), []);
});

await check("临床请求经 readJsonRequest 加密落盘；盘上搜不到病历原文；导出端解出原请求体、客户编号与查询串", async () => {
  const dir = freshDir();
  await enable(dir);
  const req = requestOf("/tcm-cdss/api/diagnosis/red-flags?prefetch=diagnose", clinicalBody, { "x-cdss-regenerate": "1" });
  const parsed = await readJsonRequest(req);
  assert.equal(parsed.ok, true);
  await archive.requestArchiveIdle();
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^requests-\d{8}\.ndjson$/);
  const raw = readFileSync(join(dir, files[0]), "utf8");
  assert.doesNotMatch(raw, /王某某|胃脘|hospital-a|archive-case-1|prefetch/, "明文只能有时间与路由");
  const lines = linesIn(dir).map((text) => JSON.parse(text));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].route, "/api/diagnosis/red-flags", "路由去掉 basePath 与查询串");
  assert.equal(lines[0].kid, material().kid);
  const payload = exporter.decryptRequestArchiveLine(lines[0], material());
  assert.deepEqual(payload.body, clinicalBody);
  assert.equal(payload.customerIdHeader, "hospital-a");
  assert.equal(payload.query, "?prefetch=diagnose");
  assert.equal(payload.regenerate, "1");
  assert.equal(payload.method, "POST");
});

await check("gzip 请求体按解压后的 JSON 留存", async () => {
  const dir = freshDir();
  await enable(dir);
  const compressed = gzipSync(Buffer.from(JSON.stringify(clinicalBody)));
  const parsed = await readJsonRequest(requestOf("/api/diagnosis/assess", compressed, { "content-encoding": "gzip" }));
  assert.equal(parsed.ok, true);
  await archive.requestArchiveIdle();
  const [line] = linesIn(dir).map((text) => JSON.parse(text));
  const payload = exporter.decryptRequestArchiveLine(line, material());
  assert.deepEqual(payload.body, clinicalBody);
  assert.equal(payload.contentEncoding, "gzip");
});

await check("闭集之外不留：登录（体里是接口 Token）、库存、知识检索、快照", async () => {
  const dir = freshDir();
  await enable(dir);
  for (const path of ["/tcm-cdss/api/auth/access", "/api/drug-inventory", "/api/tcm-knowledge/search", "/api/diagnosis/snapshot", "/api/diagnosis/health", "/api/diagnosis/prescribe-extra"]) {
    await archive.archiveClinicalRequest(requestOf(path, { token: "secret-token-value" }), { token: "secret-token-value" });
  }
  assert.deepEqual(readdirSync(dir), []);
  for (const route of ["collect", "question", "question/interpret", "red-flags", "diagnose", "prescribe", "assess", "post-prescription-risk", "his-scheme", "emergency-clearance", "terminology/confirm"]) {
    assert.equal(archive.archivedRouteOf(`https://h/tcm-cdss/api/diagnosis/${route}`), `/api/diagnosis/${route}`, route);
  }
});

await check("改明文元数据（路由/时间）后解不开：一条请求不能被挂到别的接口名下", async () => {
  const dir = freshDir();
  await enable(dir);
  await archive.archiveClinicalRequest(requestOf("/api/diagnosis/diagnose", clinicalBody), clinicalBody);
  const [line] = linesIn(dir).map((text) => JSON.parse(text));
  assert.doesNotThrow(() => exporter.decryptRequestArchiveLine(line, material()));
  assert.throws(() => exporter.decryptRequestArchiveLine({ ...line, route: "/api/diagnosis/assess" }, material()));
  assert.throws(() => exporter.decryptRequestArchiveLine({ ...line, ts: new Date(0).toISOString() }, material()));
  assert.throws(() => exporter.decryptRequestArchiveLine(line, exporter.requestArchiveKeyFromSecret(`${SECRET}-rotated`)), "轮换密钥后旧留存解不开");
});

await check("超过上限停写不删：已有留存原样保留，并留一条遥测", async () => {
  const dir = freshDir();
  await enable(dir);
  await archive.archiveClinicalRequest(requestOf("/api/diagnosis/diagnose", clinicalBody), clinicalBody);
  const before = linesIn(dir);
  assert.equal(before.length, 1);
  process.env.CDSS_REQUEST_ARCHIVE_MAX_BYTES = String(Buffer.byteLength(before[0]) + 10);
  const warnings = await captureWarnings(async () => {
    await archive.archiveClinicalRequest(requestOf("/api/diagnosis/prescribe", clinicalBody), clinicalBody);
    await archive.archiveClinicalRequest(requestOf("/api/diagnosis/assess", clinicalBody), clinicalBody);
  });
  assert.deepEqual(linesIn(dir), before, "不追加、也不删除已有");
  assert.equal(warnings.filter((item) => item.reason === "archive_full_writes_paused").length, 1, "每小时只提示一次");
  delete process.env.CDSS_REQUEST_ARCHIVE_MAX_BYTES;
});

await check("写失败不影响请求：留存路径不可写时 readJsonRequest 照常返回，只留原因码", async () => {
  const blocker = join(freshDir(), "not-a-directory");
  writeFileSync(blocker, "x");
  await enable(join(blocker, "nested"));
  let parsed;
  const warnings = await captureWarnings(async () => {
    parsed = await readJsonRequest(requestOf("/api/diagnosis/prescribe", clinicalBody));
    await archive.requestArchiveIdle();
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.body, clinicalBody);
  const failure = warnings.find((item) => item.reason === "write_failed");
  assert.ok(failure, "要留 write_failed");
  assert.doesNotMatch(JSON.stringify(warnings), /王某某|胃脘/, "遥测不带请求内容");
});

await check("缺密钥不落盘、不抛错，只提示一次", async () => {
  const dir = freshDir();
  await enable(dir);
  const saved = process.env.CASE_SNAPSHOT_ENCRYPTION_KEY;
  process.env.CASE_SNAPSHOT_ENCRYPTION_KEY = "short";
  try {
    const warnings = await captureWarnings(async () => {
      await archive.archiveClinicalRequest(requestOf("/api/diagnosis/diagnose", clinicalBody), clinicalBody);
      await archive.archiveClinicalRequest(requestOf("/api/diagnosis/diagnose", clinicalBody), clinicalBody);
    });
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(warnings.filter((item) => item.reason === "key_unavailable").length, 1);
  } finally {
    process.env.CASE_SNAPSHOT_ENCRYPTION_KEY = saved;
  }
});

await check("导出脚本命令行端到端：按路由过滤、--summary 不输出病历内容、解不开的行只计数", async () => {
  const dir = freshDir();
  await enable(dir);
  await archive.archiveClinicalRequest(requestOf("/api/diagnosis/diagnose", clinicalBody), clinicalBody);
  await archive.archiveClinicalRequest(requestOf("/api/diagnosis/prescribe", clinicalBody), clinicalBody);
  const file = join(dir, readdirSync(dir)[0]);
  writeFileSync(file, `${readFileSync(file, "utf8")}{"v":1,"ts":"2026-10-12T00:00:00.000Z","route":"/api/diagnosis/assess","kid":"${material().kid}","iv":"AAAA","tag":"AAAA","data":"AAAA"}\n`);
  const env = { PATH: process.env.PATH, CASE_SNAPSHOT_ENCRYPTION_KEY: SECRET };
  const full = spawnSync(process.execPath, ["scripts/request-archive-export.mjs", `--dir=${dir}`, "--route=prescribe"], { env, encoding: "utf8" });
  assert.equal(full.status, 0, full.stderr);
  const records = full.stdout.trim().split("\n").map((text) => JSON.parse(text));
  assert.equal(records.length, 1);
  assert.equal(records[0].route, "/api/diagnosis/prescribe");
  assert.deepEqual(records[0].body, clinicalBody);
  const summary = spawnSync(process.execPath, ["scripts/request-archive-export.mjs", `--dir=${dir}`, "--summary"], { env, encoding: "utf8" });
  assert.equal(summary.status, 0, summary.stderr);
  assert.doesNotMatch(summary.stdout, /王某某|胃脘/);
  assert.equal(summary.stdout.trim().split("\n").length, 2);
  assert.match(summary.stdout, /archive-case-1/);
  assert.equal(JSON.parse(summary.stderr.trim()).failed, 1, "坏行计数而不中断");
  // 管道进容器的跑法：node --input-type=module - <参数>
  const piped = spawnSync(process.execPath, ["--input-type=module", "-", `--dir=${dir}`, "--route=diagnose"], {
    env, encoding: "utf8", input: readFileSync("scripts/request-archive-export.mjs", "utf8"),
  });
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(piped.stdout.trim().split("\n").length, 1);
});

await check("覆盖完整：闭集里每个路由都经留存入口读请求体；登录路由不经过", async () => {
  for (const route of archive.ARCHIVED_ROUTES) {
    const source = readFileSync(`src/app${route}/route.ts`, "utf8");
    assert.match(source, /readJsonRequest\(|readCustomerBoundCaseStateRequest\(/, `${route} 没有经过 readJsonRequest，请求体不会留存`);
  }
  assert.doesNotMatch(readFileSync("src/app/api/auth/access/route.ts", "utf8"), /readJsonRequest\(|readCustomerBoundCaseStateRequest\(/);
  // 2026-10-13：服务端自己发起的预先计算请求（带内部标记头且标记值核对通过）不进留存，其余请求照旧同步发起、不 await。
  const requestSource = readFileSync("src/lib/diagnosis-request.ts", "utf8");
  assert.match(requestSource, /if \(!req\.headers\.has\(INTERNAL_PRECOMPUTE_HEADER\)\) \{\s*void archiveClinicalRequest\(req, parsed\.body\);/, "不得 await：留存不能拖慢请求");
  assert.doesNotMatch(requestSource, /await archiveClinicalRequest\(/, "不得 await：留存不能拖慢请求");
  assert.match(requestSource, /if \(!internal\) void archiveClinicalRequest\(req, parsed\.body\);/, "带了标记头但标记值对不上的请求照常留存");
});

await check("compose 打开留存并落在持久卷；.env.example 有说明", async () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  assert.match(compose, /CDSS_REQUEST_ARCHIVE: \$\{CDSS_REQUEST_ARCHIVE:-true\}/);
  assert.match(compose, /CDSS_REQUEST_ARCHIVE_PATH: \/app\/runtime-data\/request-archive/);
  assert.match(compose, /- tcm-cdss-runtime:\/app\/runtime-data/);
  assert.match(readFileSync(".env.example", "utf8"), /^CDSS_REQUEST_ARCHIVE=true$/m);
});

console.log(JSON.stringify({ suite: "request-archive", checks, failures }, null, 1));
if (failures.length) process.exit(1);
