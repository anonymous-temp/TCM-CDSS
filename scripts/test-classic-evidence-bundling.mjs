/**
 * 古籍证据语料的**打包可达性**测试。
 *
 * 为什么需要一个专门测试源码写法：这类失效在 `npm run dev` 下完全看不见。
 * Turbopack 只对**字面量**实参的 `new URL("...", import.meta.url)` 建立资源引用；
 * 写成「路径数组 + 循环里 new URL(变量)」时它追不到循环变量，整个循环体被编译成
 * 同一个资源常量。实测（本仓 next build standalone，修复前）：
 *   · 编译产物里 `e.R(...)` 全篇只出现一次，常量指向 44MB 旧语料；
 *   · 292MB 的 tcmoc 语料被打包进镜像却无任何代码引用 → 146,407 条证据线上全部失效；
 *   · 旧语料被循环读了两遍 → 55,127 条记录内存翻倍，医生看到成对重复的引用。
 * 加载器对缺文件是静默 catch（语料本就可选），所以线上不会报错、不会降级，只会安静地少一半证据。
 *
 * 因此这里断言的是**源码形状**（dev/prod 都能跑），并在存在构建产物时顺带校验产物。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const sourcePath = new URL("../src/lib/tcm-classic-evidence.server.ts", import.meta.url);
const source = readFileSync(sourcePath, "utf8");

const CORPUS_FILES = [
  "../data/tcm-classic-text-evidence.jsonl",
  "../data/tcm-classic-text-evidence-tcmoc.jsonl",
];

// ① 每个语料必须有且只有一处字面量 URL 构造。
for (const file of CORPUS_FILES) {
  const literal = `new URL("${file}", import.meta.url)`;
  const occurrences = source.split(literal).length - 1;
  assert.equal(occurrences, 1,
    `${file} 必须以字面量形式构造 URL 恰好一次（实际 ${occurrences} 次）——` +
    "写成变量或循环变量会让 Turbopack 只保留一个资源引用，该语料线上永久失效");
}

// ② 不允许任何以标识符（而非字符串字面量）作首参的 URL 构造。这正是回归会长成的样子。
const variableUrl = /new URL\(\s*(?!["'`])[A-Za-z_$][\w$.]*\s*,\s*import\.meta\.url\s*\)/.exec(source);
assert.equal(variableUrl, null,
  `禁止 new URL(变量, import.meta.url)：Turbopack 无法静态求值，会把多个语料折叠成一个。命中：${variableUrl?.[0]}`);

// ③ 运行时逐语料条数必须可观测——缺语料是允许的，静默是不允许的。
const { classicEvidenceCorpusStatus, classicEvidenceForFormulaNames } =
  await import("../src/lib/tcm-classic-evidence.server.ts");
const status = classicEvidenceCorpusStatus();
assert.equal(status.length, CORPUS_FILES.length, "每个语料都必须单独上报加载条数");
for (const item of status) {
  assert.ok(typeof item.records === "number", `${item.name} 必须上报条数`);
}

// ④ 本机语料齐备时，必须两个语料都真的贡献了记录。
//    tcmoc 语料未纳入 git（292MB），干净克隆里不存在，因此缺失时跳过而不是失败。
const present = status.filter((item) =>
  existsSync(new URL(`../src/data/${item.name}`, import.meta.url)));
for (const item of present) {
  assert.ok(item.records > 0,
    `${item.name} 文件存在却加载到 0 条——加载路径没有指向它（正是打包折叠的表现）`);
}

// ⑤ 语料齐备时，tcmoc 独有的书名篇名式 citation 必须真的到达查询结果。
//    旧语料的 citation 全是 pdf-evidence:<hash>#p<n>，只有 tcmoc 是《书名》·篇名。
if (present.length === CORPUS_FILES.length) {
  const hits = classicEvidenceForFormulaNames(["归脾汤", "桂枝汤", "银翘散"]);
  assert.ok(hits.some((hit) => /^《.+》/.test(String(hit.citation || ""))),
    "查询结果里必须出现 tcmoc 的《书名》·篇名式 citation，否则该语料没有参与检索");
}

// ⑥ 若存在构建产物，直接校验编译后的资源引用数——这是唯一能验证真实产物的检查。
const chunkDir = new URL("../.next/server/chunks/", import.meta.url);
if (existsSync(chunkDir)) {
  const chunk = readdirSync(chunkDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, text: readFileSync(new URL(name, chunkDir), "utf8") }))
    .find((item) => item.text.includes("tcm-classic-text-evidence"));
  if (chunk) {
    const assetIds = new Set([...chunk.text.matchAll(/\.R\((\d+)\)/g)].map((match) => match[1]));
    assert.ok(assetIds.size >= CORPUS_FILES.length,
      `构建产物只引用了 ${assetIds.size} 个语料资源，应为 ${CORPUS_FILES.length} 个——` +
      `多个语料被折叠成一个（chunk: ${chunk.name}）`);
  }
}

console.log(JSON.stringify({
  corpora: status,
  checkedBuildOutput: existsSync(chunkDir),
  failures: 0,
}));
