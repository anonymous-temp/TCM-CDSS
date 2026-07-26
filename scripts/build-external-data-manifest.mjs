// 外部数据清单：让"未入库"这件事可见、可校验。
//
// `中医补充数据/`(2.3GB, 1419 文件) 与 `参考/`(149MB) 是**构建输入**——语料与第三方参考实现，
// 不是应用源码。它们不入 git，也不进镜像（.dockerignore 第 14/18 行已挡）。
//
// 但"不入库"不该是**静默**的：换台机器、或要重跑 ingest 重建 tcm-classic-text-evidence*.jsonl /
// 医案语料时，得知道少了什么、以及手上这份对不对。所以这里生成一份清单进 git：
// 目录体量、文件数、以及每个 >10MB 大文件的 sha256。核对失败就说明语料版本不一致，
// 而不是让下游默默少一半证据（tcm-classic-evidence 那次 Turbopack 资源追踪失效就是这么发生的）。
//
// 用法: node scripts/build-external-data-manifest.mjs
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["中医补充数据", "参考"];
const LARGE_FILE_BYTES = 10 * 1024 * 1024;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function sha256(path) {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")))
      .on("error", fail);
  });
}

const roots = [];
for (const name of ROOTS) {
  const dir = resolve(ROOT, name);
  if (!existsSync(dir)) {
    roots.push({ path: name, present: false });
    continue;
  }
  const files = walk(dir);
  const totalBytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
  const large = [];
  for (const file of files.filter((item) => statSync(item).size >= LARGE_FILE_BYTES)
    .sort((left, right) => statSync(right).size - statSync(left).size)) {
    large.push({
      path: relative(ROOT, file),
      bytes: statSync(file).size,
      sha256: await sha256(file),
    });
  }
  roots.push({
    path: name,
    present: true,
    fileCount: files.length,
    totalBytes,
    totalMB: Math.round(totalBytes / 1048576),
    largeFiles: large,
  });
}

const manifest = {
  schemaVersion: "external-data-manifest-v1",
  note: [
    "这些目录是构建输入（语料 / 第三方参考实现），不是应用源码：不入 git、不进镜像。",
    "清单进 git 是为了让缺失可见——换机器或重跑 ingest 前，按 sha256 核对手上这份是否一致。",
    "校验: node scripts/build-external-data-manifest.mjs 后 git diff 该文件；无差异即一致。",
  ].join(""),
  dockerignored: true,
  gitignored: true,
  roots,
};
const out = resolve(ROOT, "src/data/external-data-manifest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  roots: roots.map((item) => ({ path: item.path, present: item.present, totalMB: item.totalMB, files: item.fileCount, largeFiles: item.largeFiles?.length })),
  out: relative(ROOT, out),
}, null, 2));
