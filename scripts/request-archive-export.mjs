#!/usr/bin/env node
// 解密导出临床请求留存（src/lib/request-archive.server.ts 写入的 requests-YYYYMMDD.ndjson）。
//
// 只依赖 node 内置模块：生产镜像里没有 scripts/，直接把本文件管道进容器执行，密钥与目录取容器自己的环境变量，
// 密钥不出容器：
//   ssh evimed "docker exec -i tcm-cdss-deepseek-green-20260911-tcm-cdss-1 node --input-type=module - --since=2026-10-12T00:00:00+08:00" \
//     < scripts/request-archive-export.mjs > <本机 0600 目录>/requests.ndjson
// 参数：--dir=<目录>（缺省 CDSS_REQUEST_ARCHIVE_PATH）  --since=/--until=<ISO 时间>  --route=<路由子串，如 prescribe>
//       --kind=request|response（2026-10-26 起响应也留存：响应行 kind="response"，与请求行用 exchangeId 对上；旧请求行没有 kind）
//       --summary（只输出每条的时间、路由、客户编号与请求体字节数，不输出病历内容）
// 输出：请求行 {ts, route, kid, method, query?, customerIdHeader?, regenerate?, contentEncoding?, exchangeId?, body}；
//       响应行 {ts, route, kid, kind:"response", exchangeId, status, contentType?, stageResult?, customerIdHeader?, body(正文文本), truncated, aborted, ms}；
// 解不开的行（密钥已轮换、行被截断）只在 stderr 计数，不中断导出。
import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const KEY_CONTEXT = "tcm-cdss-request-archive-v1";

export function requestArchiveKeyFromSecret(secret) {
  if (!secret || secret.length < 16) return undefined;
  const root = createHash("sha256").update(secret).digest();
  const key = createHmac("sha256", root).update(KEY_CONTEXT).digest();
  return { key, kid: createHash("sha256").update(key).digest("hex").slice(0, 8) };
}

export function decryptRequestArchiveLine(line, material) {
  const decipher = createDecipheriv("aes-256-gcm", material.key, Buffer.from(line.iv, "base64"));
  decipher.setAAD(Buffer.from(`${line.v}|${line.ts}|${line.route}`, "utf8"));
  decipher.setAuthTag(Buffer.from(line.tag, "base64"));
  const compressed = Buffer.concat([decipher.update(Buffer.from(line.data, "base64")), decipher.final()]);
  return JSON.parse(gunzipSync(compressed).toString("utf8"));
}

function args(argv) {
  const out = {};
  for (const item of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(item);
    if (match) out[match[1]] = match[2] ?? true;
  }
  return out;
}

function main() {
  const opts = args(process.argv.slice(1));
  const dir = opts.dir || process.env.CDSS_REQUEST_ARCHIVE_PATH;
  if (!dir) { console.error("需要 --dir 或 CDSS_REQUEST_ARCHIVE_PATH"); process.exit(2); }
  const material = requestArchiveKeyFromSecret(process.env.CASE_SNAPSHOT_ENCRYPTION_KEY || "");
  if (!material) { console.error("CASE_SNAPSHOT_ENCRYPTION_KEY 不可用，无法解密"); process.exit(2); }
  const since = opts.since ? Date.parse(opts.since) : -Infinity;
  const until = opts.until ? Date.parse(opts.until) : Infinity;
  let names;
  try {
    names = readdirSync(dir).filter((name) => /^requests-\d{8}\.ndjson$/.test(name)).sort();
  } catch (error) {
    if (error?.code === "ENOENT") { console.error(JSON.stringify({ exported: 0, note: "留存目录尚不存在" })); return; }
    throw error;
  }
  let exported = 0, failed = 0, otherKey = 0;
  for (const name of names) {
    for (const raw of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!raw.trim()) continue;
      let line;
      try { line = JSON.parse(raw); } catch { failed += 1; continue; }
      const at = Date.parse(line.ts);
      if (!(at >= since && at <= until)) continue;
      if (opts.route && !String(line.route).includes(opts.route)) continue;
      if (line.kid !== material.kid) { otherKey += 1; continue; }
      let payload;
      try { payload = decryptRequestArchiveLine(line, material); } catch { failed += 1; continue; }
      const record = { ts: line.ts, route: line.route, kid: line.kid, ...payload };
      const kind = record.kind === "response" ? "response" : "request";
      if (opts.kind && opts.kind !== kind) continue;
      if (opts.summary) {
        process.stdout.write(`${JSON.stringify({ ts: record.ts, route: record.route, kind, customerIdHeader: record.customerIdHeader,
          exchangeId: record.exchangeId, status: record.status,
          caseId: record.body?.caseState?.id, bodyBytes: Buffer.byteLength(typeof record.body === "string" ? record.body : JSON.stringify(record.body ?? null)) })}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(record)}\n`);
      }
      exported += 1;
    }
  }
  console.error(JSON.stringify({ exported, failed, otherKey, files: names.length }));
}

// 管道进容器时 process.argv[1] 是 "-"；被套件 import 时不执行。
const invokedDirectly = process.argv[1] === "-" || (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()));
if (invokedDirectly) main();
