/**
 * 古籍证据的**生产可达性**测试（2026-09-28 重写）。
 *
 * 历史：运行期曾用 `readFileSync(new URL("../data/x.jsonl", import.meta.url))` 直读三份原始语料。
 * dev/jiti 下正常；生产 standalone（webpack）把它改写成资产相对 URL，fs 读不到、catch 后静默 0 条——
 * 9/27 实测麻黄汤 jiti 12 条、生产 0 条，「原典出处」线上一直是空的。即使读得到，tcmoc 语料 347MB，
 * 整份解析会顶爆 2GiB 容器。现在运行期只读构建期派生的紧凑索引（process.cwd()/src/data），
 * 原始语料排除出镜像。这里钉住：①运行期不再碰原始语料；②索引与当前语料同步；③索引查询与全量扫描逐条一致；
 * ④ 原始语料不进镜像。
 */
import assert from "node:assert/strict";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

// 只看代码，不看注释（注释里保留了历史写法的说明）。
const source = readFileSync(new URL("../src/lib/tcm-classic-evidence.server.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const CORPUS_FILES = [
  "tcm-classic-text-evidence.jsonl",
  "tcm-classic-text-evidence-tcmoc.jsonl",
  "tcm-classic-text-evidence-books.jsonl",
];

// ① 运行期只读索引，且按 process.cwd() 拼路径（不得再用 import.meta.url 资源引用）。
assert.match(source, /readFileSync\(\s*path\.join\(process\.cwd\(\), "src", "data", CLASSIC_INDEX_FILE\)/,
  "运行期必须按 process.cwd()/src/data 读紧凑索引");
assert.doesNotMatch(source, /import\.meta\.url/, "运行期不得再用 import.meta.url 读数据（生产 standalone 下静默读不到）");
for (const file of CORPUS_FILES) {
  assert.doesNotMatch(source, new RegExp(`readFileSync\\([^)]*${file.replace(/[.]/g, "\\.")}`),
    `运行期不得再直读原始语料 ${file}`);
}

// ④ 原始语料排除出镜像追踪（运行期不读它们；347MB 进镜像只是负担）。
const nextConfig = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
for (const file of CORPUS_FILES) {
  assert.ok(nextConfig.includes(`"src/data/${file}"`), `next.config.ts 必须把 ${file} 排除出 outputFileTracing`);
}
assert.ok(!nextConfig.includes('"src/data/tcm-classic-evidence-formula-index.json"'), "索引本身必须随镜像发布");

const { classicEvidenceCorpusStatus, classicEvidenceForFormulaNames, classicEvidenceFromFullRecords,
  isRuntimeEligibleClassicRecord, CLASSIC_INDEX_FILE } = await import("../src/lib/tcm-classic-evidence.server.ts");
const indexUrl = new URL(`../src/data/${CLASSIC_INDEX_FILE}`, import.meta.url);
assert.ok(existsSync(indexUrl), "紧凑索引必须入库：npm run build:classic-evidence-index");
const index = JSON.parse(readFileSync(indexUrl, "utf8"));

// ③ 运行期逐语料条数必须可观测（records = 构建时读到的原始条数，indexed = 进索引条数）。
const status = classicEvidenceCorpusStatus();
assert.equal(status.length, CORPUS_FILES.length, "每个语料都必须单独上报");
for (const item of status) {
  assert.ok(item.records > 0 && item.indexed > 0, `${item.name} 必须真的进入索引（records=${item.records}, indexed=${item.indexed}）`);
}
const hits = classicEvidenceForFormulaNames(["归脾汤", "桂枝汤", "银翘散"]);
assert.ok(hits.some((hit) => /^《.+》/.test(String(hit.citation || ""))), "tcmoc 的《书名》·篇名式 citation 必须到达查询结果");
assert.equal(classicEvidenceForFormulaNames(["麻黄汤"]).length, 12, "常用经典方应取满 12 条");

// ② 语料在本机齐备（不是 LFS 指针）时：索引与语料逐字节同步，且查询与全量扫描逐条一致。
const lfsPointer = (file) => readFileSync(new URL(`../src/data/${file}`, import.meta.url), { encoding: "utf8" }).startsWith("version https://git-lfs");
const present = CORPUS_FILES.filter((file) => existsSync(new URL(`../src/data/${file}`, import.meta.url)) &&
  statSync(new URL(`../src/data/${file}`, import.meta.url)).size > 1024 && !lfsPointer(file));
if (present.length === CORPUS_FILES.length) {
  const records = [];
  for (const file of CORPUS_FILES) {
    const url = new URL(`../src/data/${file}`, import.meta.url);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(url)) hash.update(chunk);
    const recorded = index.sources.find((item) => item.name === file);
    assert.equal(recorded?.sha256, hash.digest("hex"), `${file} 已变，索引过期：npm run build:classic-evidence-index`);
    for await (const line of createInterface({ input: createReadStream(url, "utf8"), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (isRuntimeEligibleClassicRecord(record)) records.push(record);
    }
  }
  const names = Object.keys(index.byFormula);
  const queries = [
    ...names.filter((_, position) => position % 7 === 0).map((name) => [name]),
    ...Array.from({ length: 120 }, (_, i) => [names[(i * 7) % names.length], names[(i * 13 + 5) % names.length]]),
    ["归脾汤", "酸枣仁汤"], ["麻黄汤"], ["小柴胡汤加减"], ["葛根芩连汤"],
  ];
  const mismatched = queries.filter((query) =>
    JSON.stringify(classicEvidenceFromFullRecords(records, query)) !== JSON.stringify(classicEvidenceForFormulaNames(query)));
  assert.deepEqual(mismatched, [], "索引查询必须与全量扫描逐条一致");
  console.log(`[test:classic-evidence-bundling] parity ${queries.length} queries over ${records.length} eligible records`);
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
  indexRecords: index.records.length,
  failures: 0,
}));
