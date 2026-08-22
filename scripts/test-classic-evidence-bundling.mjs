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
  // 书籍语料补充（2026-08-09）。新增语料必须同样写成独立字面量 URL——
  // 这正是本套件存在的原因：循环变量写法会让 Turbopack 把整个循环体编译成同一个资源常量，
  // 结果是语料进了镜像却从未被读取，且不报错、不降级，只安静地少一批证据。
  "../data/tcm-classic-text-evidence-books.jsonl",
];

// ① 每个语料的 readFileSync 必须直接包住字面量 URL。仅在数组里构造字面量 URL、再把
// source.url 传给 readFileSync，仍会让 Turbopack/NFT 把 fs 模式扩成整个项目。
for (const file of CORPUS_FILES) {
  const literal = `new URL("${file}", import.meta.url)`;
  const occurrences = source.split(literal).length - 1;
  assert.equal(occurrences, 1,
    `${file} 必须以字面量形式构造 URL 恰好一次（实际 ${occurrences} 次）——` +
    "写成变量或循环变量会让 Turbopack 只保留一个资源引用，该语料线上永久失效");
  const escapedLiteral = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    source,
    new RegExp(`readFileSync\\(\\s*${escapedLiteral}\\s*,\\s*"utf8"\\s*,?\\s*\\)`),
    `${file} 必须在 readFileSync 调用点直接使用字面量 URL，禁止经 source.url/数组间接传递`,
  );
}
assert.doesNotMatch(source, /readFileSync\(\s*source\.(?:url|path)/,
  "Turbopack/NFT 会把 readFileSync(source.url) 追踪成宽泛文件模式");

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
//    两个语料现已入库；仍按"存在才断言"处理，因为加载器把语料视为可选（缺文件静默 catch），
//    测试不应比运行时更严，否则精简部署会红在测试而不是红在真正的问题上。
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
// Turbopack 用 `.R(<asset id>)`，Webpack 则生成 `static/media/<name>.<hash>.jsonl`。
// 两种都是 Next.js 16 的正式产物形式；闸门必须校验资源可达性，不能绑定某一构建器的内部编号。
const chunkDir = new URL("../.next/server/chunks/", import.meta.url);
if (existsSync(chunkDir)) {
  const chunks = readdirSync(chunkDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, text: readFileSync(new URL(name, chunkDir), "utf8") }))
    .filter((item) => item.text.includes("tcm-classic-text-evidence"));
  if (chunks.length > 0) {
    const combined = chunks.map((item) => item.text).join("\n");
    const webpackAssets = new Set(
      [...combined.matchAll(/static\/media\/(tcm-classic-text-evidence(?:-tcmoc|-books)?\.[a-z0-9]+\.jsonl)/g)]
        .map((match) => match[1]),
    );
    const turbopackAssetIds = new Set(
      [...combined.matchAll(/\.R\((\d+)\)/g)].map((match) => match[1]),
    );
    const referencedAssetCount = Math.max(webpackAssets.size, turbopackAssetIds.size);
    assert.ok(referencedAssetCount >= CORPUS_FILES.length,
      `构建产物只引用了 ${referencedAssetCount} 个语料资源，应为 ${CORPUS_FILES.length} 个——` +
      `多个语料被折叠成一个（chunks: ${chunks.map((item) => item.name).join(", ")}）`);
  }
}

// ─── 结构化候选里的经典证据条数必须在 contract 上限之内 ───
// contract 是 z.array(...).max(6).optional().catch([])：catch 的语义是**整段清空**而不是截断。
// 解析器返回最多 12 条（M04 提示词那一路要用满 12），若原样塞进结构化字段，
// 7~12 条会让该候选的经典证据一条不剩且不报错——tcmoc 语料接上后 12 条正是常态。
const contractSource = readFileSync(new URL("../src/lib/diagnosis-types.ts", import.meta.url), "utf8");
const contractLimit = /classicEvidence: z\.array\(z\.object\(\{[\s\S]*?\}\)\)\.max\((\d+)\)/.exec(contractSource);
assert.ok(contractLimit, "必须能从 contract 里读出 classicEvidence 的 max 上限");
const provenanceSource = readFileSync(new URL("../src/lib/tcm-formula-provenance.ts", import.meta.url), "utf8");
const appliedLimit = /const CANDIDATE_CLASSIC_EVIDENCE_LIMIT = (\d+);/.exec(provenanceSource);
assert.ok(appliedLimit, "provenance 侧必须显式声明截断上限，而不是把解析器结果原样塞进 contract");
assert.equal(appliedLimit[1], contractLimit[1],
  `provenance 截断上限(${appliedLimit?.[1]}) 必须等于 contract 上限(${contractLimit?.[1]})——` +
  "两者漂移时 catch([]) 会静默清空整段经典证据");
assert.match(provenanceSource, /classicEvidence:[\s\S]{0,400}?\.slice\(0, CANDIDATE_CLASSIC_EVIDENCE_LIMIT\)/,
  "classicEvidence 赋值处必须实际应用该上限");


// ─── 证据安全分级必须真的生效，且不得误伤受控方 ───
// 曾经对全部 222,338 条硬编码 safetyClass:"standard"，整批绕过隔离机制——运行时只放行 standard，
// 而唯一防线 CLASSIC_RUNTIME_DANGEROUS_CONTENT 只拦下 683 条，含毒剧/禁用物质的却有两万条量级。
// 分级按**物质危险性**而非「提没提剂量」：照搬旧语料的 restrictedPattern 会把 52.7% 判成 restricted
// （古籍方书剂量煎服本来就是正文主体），把语料砍掉一半且理由是错的。
const tcmocManifest = JSON.parse(readFileSync(
  new URL("../src/data/tcm-classic-text-evidence-tcmoc-manifest.json", import.meta.url), "utf8"));
assert.ok(tcmocManifest.safetyCounts, "切片器必须逐级上报 safetyClass 分布");
assert.ok(tcmocManifest.safetyCounts.restricted > 0 && tcmocManifest.safetyCounts.quarantine > 0,
  `安全分级不得退回全量 standard（实际 ${JSON.stringify(tcmocManifest.safetyCounts)}）`);
// 分级不能过度：restricted 占比过高说明又把「提到剂量」当成了危险信号。
const gradedTotal = Object.values(tcmocManifest.safetyCounts).reduce((sum, value) => sum + value, 0);
assert.ok(tcmocManifest.safetyCounts.restricted / gradedTotal < 0.2,
  `restricted 占比过高（${(tcmocManifest.safetyCounts.restricted / gradedTotal * 100).toFixed(1)}%），` +
  "说明分级判据又把古籍正文里的剂量煎服文本当成了危险内容");

// 受控方剂的经典出处不得因分级消失——十枣汤(甘遂大戟芫花)、真武汤(附子)都含药典有制品的毒性药，
// 它们的用药安全由确定性剂量门禁与处方后审方承担，分级不该替代也不该重复那两层。
if (present.length === CORPUS_FILES.length) {
  for (const name of ["十枣汤", "真武汤", "四逆汤", "归脾汤", "桂枝汤"]) {
    assert.ok(classicEvidenceForFormulaNames([name]).length > 0,
      `受控方剂的经典证据不得因安全分级被清空：${name}`);
  }
  // 反向：禁用/重金属/剧毒物质不得出现在可检索摘录里。
  const banned = /(砒霜|砒石|水银|轻粉|铅丹|黄丹|密陀僧|斑蝥|蟾酥|马钱子|生川乌|生草乌|藜芦)/;
  const sampled = ["朱砂安神丸", "至宝丹", "苏合香丸", "安宫牛黄丸", "十枣汤", "真武汤"]
    .flatMap((name) => classicEvidenceForFormulaNames([name]));
  const leaked = sampled.filter((hit) => banned.test(String(hit.excerpt || "")));
  assert.deepEqual(leaked.map((hit) => hit.citation), [],
    "禁用/剧毒物质不得出现在可检索的证据摘录中");
}

console.log(JSON.stringify({
  corpora: status,
  checkedBuildOutput: existsSync(chunkDir),
  failures: 0,
}));
