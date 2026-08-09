/**
 * 可复用检索层（cjk-analyzer + bm25）与首个迁移场（药材知识库检索）的回归。
 *
 * 迁移边界（改动前必读）：**只改排序，不改准入**。把绝对阈值换成「取分数前 N」会让
 * fail-closed 的「查不到」状态永不可达——本项目明令禁止的形状。因此本套件的要害断言是
 * 三条**不变量**，而不是「排得更好」：
 *   ① 每一味药用自己的名字查，必须能查到（695/695，零缺失）；
 *   ② 无意义查询必须仍然 0 结果（不得凭空造候选）；
 *   ③ 精确药名命中仍原样置顶、分数仍是 100（高精度路不受 BM25 影响）。
 *
 * 分析器为什么不用 Intl.Segmenter：实测它对中医术语几乎全线失效
 * （证候词 3164 条只有 1.0% 被切成单一词，方名 0.3%，黄芪→黄/芪）。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true, interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});

const { analyze, buildControlledVocabulary, normalizeForRetrieval } =
  await jiti.import("../src/lib/retrieval/cjk-analyzer.ts");
const { buildBm25Index } = await jiti.import("../src/lib/retrieval/bm25.ts");
const { searchTcmKnowledge } = await jiti.import("../src/lib/tcm-knowledge.ts");
const knowledge = (await import(path.join(repoRoot, "src/data/tcm-knowledge.json"), { with: { type: "json" } })).default;

let checks = 0;
const failures = [];
const ok = (label, condition) => { checks += 1; if (!condition) failures.push(label); };

// ── 分析器 ──────────────────────────────────────────────────────────────────
ok("归一去标点空白", normalizeForRetrieval(" 黄芪，30克。") === "黄芪30克");
const vocab = buildControlledVocabulary(["黄芪", "白术", "补气升阳"]);
const terms = analyze("黄芪补气升阳白术", vocab).map((t) => `${t.route}:${t.term}`);
ok("受控词表整词命中（黄芪不被切成黄/芪）", terms.includes("vocabulary:黄芪"));
ok("受控词表最长匹配优先（补气升阳 而非 补气）", terms.includes("vocabulary:补气升阳"));
ok("未命中段落走 bigram 兜底", analyze("寒热往来").some((t) => t.route === "bigram"));
ok("单字词不进受控词表", buildControlledVocabulary(["气", "补气"]).terms.has("气") === false);
ok("空串产出空词项", analyze("").length === 0);

// ── BM25 基本性质 ────────────────────────────────────────────────────────────
const docs = [
  { id: "a", title: "黄芪", body: "补气升阳，固表止汗" },
  { id: "b", title: "白术", body: "健脾益气，燥湿利水" },
  { id: "c", title: "茯苓", body: "利水渗湿，健脾宁心" },
];
const index = buildBm25Index(docs, [
  { name: "title", weight: 6, text: (d) => d.title },
  { name: "body", weight: 1, text: (d) => d.body },
]);
ok("索引规模正确", index.size === 3);
ok("精确名查询命中自身", index.search("黄芪", 3)[0]?.doc.id === "a");
ok("无命中查询返回空（不得凭空造候选）", index.search("zzzz量子", 3).length === 0);
ok("字段权重生效：标题命中优先于正文命中", index.search("白术", 3)[0]?.doc.id === "b");
const limited = index.search("健脾", 1);
ok("limit 生效", limited.length <= 1);

// ── 迁移场不变量：药材知识库检索 ─────────────────────────────────────────────
const herbs = knowledge.herbs || [];
ok("知识库药材非空", herbs.length > 100);

// ① 每一味药自名可检出。这是本次迁移最硬的一条：排序可以变，可检出性不能退。
const missing = [];
for (const herb of herbs) {
  if (!searchTcmKnowledge(herb.name, 10).some((hit) => hit.name === herb.name)) missing.push(herb.name);
}
ok(`① 每味药自名可检出（缺失 ${missing.length}/${herbs.length}）`, missing.length === 0);
if (missing.length) failures.push(`  缺失样例: ${missing.slice(0, 8).join("、")}`);

// ② 无意义查询仍然 0 结果。打分化检索最典型的 fail-open 就是「总能给出分数最高的一条」。
for (const nonsense of ["zzzzqqq", "区块链量子纠缠", "外星科技"]) {
  ok(`② 无意义查询 0 结果: ${nonsense}`, searchTcmKnowledge(nonsense, 10).length === 0);
}

// ③ 精确药名命中仍置顶且分数为 100（高精度路不受 BM25 影响）。
const sample = herbs.slice(0, 40);
let exactTopped = 0;
for (const herb of sample) {
  const hits = searchTcmKnowledge(herb.name, 5);
  if (hits[0]?.name === herb.name && hits[0]?.score === 100) exactTopped += 1;
}
ok(`③ 精确名置顶且 score=100（${exactTopped}/${sample.length}）`, exactTopped >= Math.floor(sample.length * 0.8));

if (failures.length > 0) {
  console.error("[test:retrieval-bm25] 失败项：");
  for (const item of failures) console.error("  - " + item);
}
assert.equal(failures.length, 0, `${failures.length}/${checks} 项失败`);
console.log(`[test:retrieval-bm25] OK — ${checks} 项断言全过；${herbs.length} 味药自名可检出零缺失`);
