// 运行时数据完整性：线上真正会读的每个数据文件，必须在仓库里、在镜像里、且真的加载出内容。
//
// 为什么要有这条套件：原始语料 2.3GB 不入库、不进镜像是对的（构建期由 scripts/ingest/* 消费，
// 产物落在 src/data/）。但这条边界一旦划错方向，失效是**静默**的——
// tcmoc 那次就是：292MB 语料打进了镜像却因 Turbopack 资源追踪失效从未被读取，
// 146,407 条古籍证据线上全部消失，不报错、不降级，只是医生看到的引用少了一半。
//
// 所以这里同时钉三件事：
//   1. 源码 import/new URL 引用的每个 src/data 文件都存在（少一个就是构建即缺数据）
//   2. .dockerignore 不得把 src/data 排除掉（镜像里没有 = 线上没有）
//   3. 两个古籍语料真的加载出记录，且不低于下限（存在 ≠ 被读到，见上）
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": join(ROOT, "src") } });

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// 两种引用写法都要扫：静态 import（打包器解析）与 new URL(字面量, import.meta.url)（运行时读盘）。
const REFERENCE = /(?:from\s+"[^"]*?data\/([\w.-]+\.(?:json|jsonl))"|new URL\(\s*"[^"]*?data\/([\w.-]+\.(?:json|jsonl))")/g;
const referenced = new Set();
for (const file of [...sourceFiles(join(ROOT, "src", "lib")), ...sourceFiles(join(ROOT, "src", "app"))]) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(REFERENCE)) referenced.add(match[1] || match[2]);
}
assert.ok(referenced.size >= 30,
  `只扫到 ${referenced.size} 个运行时数据引用，正则口径可能失配——先修这里，别让断言空转`);

const missing = [...referenced].filter((name) => !existsSync(join(ROOT, "src", "data", name)));
assert.deepEqual(missing, [],
  `源码引用了但仓库里不存在的数据文件（构建即缺数据）：${missing.join("、")}`);

// 未纳入 git 的运行时数据 = 换台机器就没有 = 镜像构建时缺失。
let untracked = [];
try {
  const tracked = new Set(execFileSync("git", ["ls-files", "src/data"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").map((line) => line.replace(/^src\/data\//, "").trim()).filter(Boolean));
  untracked = [...referenced].filter((name) => !tracked.has(name));
} catch {
  // 不在 git 工作树里（例如镜像内跑）时跳过这一项，其余断言仍然有效。
}
assert.deepEqual(untracked, [],
  `运行时数据文件未纳入 git，换机器/构建镜像时会缺失：${untracked.join("、")}`);

// 镜像里没有 = 线上没有。这条防的是有人为了瘦身把 src/data 或 *.jsonl 加进 .dockerignore。
const dockerignore = readFileSync(join(ROOT, ".dockerignore"), "utf8")
  .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
const dataExcluded = dockerignore.filter((line) => /^\/?src(\/data)?\/?$/.test(line) || /\*\.jsonl$/.test(line));
assert.deepEqual(dataExcluded, [],
  `.dockerignore 排除了运行时数据，镜像里将缺失：${dataExcluded.join("、")}`);

// 存在 ≠ 被读到。古籍语料是 new URL 运行时读盘，Turbopack 资源追踪一旦失配就静默读不到，
// 因此必须断言"真的解析出记录"，而不是"文件在"。下限取当前值的九成，允许语料增长、不许塌方。
const { classicEvidenceCorpusStatus } = await jiti.import("../src/lib/tcm-classic-evidence.server.ts");
const corpora = classicEvidenceCorpusStatus();
const CORPUS_FLOOR = { "tcm-classic-text-evidence.jsonl": 49000, "tcm-classic-text-evidence-tcmoc.jsonl": 200000 };
for (const [name, floor] of Object.entries(CORPUS_FLOOR)) {
  const loaded = corpora.find((item) => item.name === name)?.records ?? 0;
  assert.ok(loaded >= floor,
    `古籍语料 ${name} 只加载到 ${loaded} 条（下限 ${floor}）——文件在不等于被读到，` +
    "检查 tcm-classic-evidence.server.ts 的 new URL 是否仍是可静态求值的字面量");
}

// 大文件单独报一下，便于核对镜像体积来源。
const sizes = [...referenced]
  .map((name) => ({ name, mb: Math.round(statSync(join(ROOT, "src", "data", name)).size / 1048576) }))
  .filter((item) => item.mb >= 10)
  .sort((left, right) => right.mb - left.mb);

console.log(JSON.stringify({
  runtimeDataFiles: referenced.size,
  missing: missing.length,
  untracked: untracked.length,
  corpora: corpora.map((item) => `${item.name}:${item.records}`),
  largeFilesMB: sizes.map((item) => `${item.name}:${item.mb}MB`),
  failures: 0,
}));
