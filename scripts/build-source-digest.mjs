// 关键源码摘要(2026-08-04)。
//
// 甲方评测第 10 条:「本地 52/52 回归全绿,但线上行为与本地红旗非剂量合同相反,说明目前
// 无法证明"测试过的源码"就是"线上运行的镜像"」。这是元缺陷——无法证明镜像一致时,
// 「已修复」就成了无法验证的断言,而分歧可能根本不在源码而在部署链路。
//
// 本脚本对**决定临床行为**的源码与受治理数据算一个稳定摘要。构建期打进镜像,
// health 回显,部署后与本地重算值比对:不一致 = 部署没生效,而不是"代码没修好"。
//
// 只摘要临床行为相关文件(src/lib + src/app/api + 受治理数据),不含 README/文档/测试——
// 这样改文档不会让摘要漂移,而改一行安全逻辑一定会。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src/lib", "src/app/api"];
const DATA_DIR = "src/data";

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const files = [];
for (const root of ROOTS) files.push(...walk(root));
// 受治理数据只取文件名 + 大小 + 内容哈希:大语料逐字节读一遍太慢,但内容变了哈希一定变。
if (fs.existsSync(DATA_DIR)) {
  for (const name of fs.readdirSync(DATA_DIR).sort()) {
    if (/\.(json|jsonl)$/.test(name)) files.push(path.join(DATA_DIR, name));
  }
}

const overall = crypto.createHash("sha256");
const perFile = [];
for (const file of files.sort()) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  overall.update(`${file}:${hash}\n`);
  perFile.push({ file, hash: hash.slice(0, 12) });
}

const digest = overall.digest("hex");
const summary = { digest, fileCount: files.length, algorithm: "sha256-of-sorted-file-hashes" };

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...summary, files: perFile }, null, 2));
} else if (process.argv.includes("--quiet")) {
  process.stdout.write(digest);
} else {
  console.log(JSON.stringify(summary, null, 2));
}
