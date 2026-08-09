/**
 * 书籍语料证据条目的入库治理回归。
 *
 * 甲方 2026-08-09 决定集成该语料（版权由甲方负责），但要求做噪声过滤。本套件钉住的是
 * **过滤之后仍然必须成立的四条**，而不是「过滤跑过了」：
 *   ① 危险内容零漏出 —— 带克数药膳 / 炼丹矿物毒药剂量 / 食疗直接映射西医病名；
 *   ② 剂量零泄漏 —— 所有条目过运行期脱敏后不得残留具体剂量（简繁两侧）；
 *   ③ 不得压过受治理经典条文 —— tier="book" 在 tierRank 里必须排在 canon/common/experience 之后；
 *   ④ 不得填充空态 —— 未命中方名时仍然返回空，不得因为多了一个语料就「总能给出一条」。
 *
 * 第 ④ 条是本次集成最大的风险面：新增语料最典型的 fail-open 就是把「查不到」变成
 * 「查到一条不相干的」。本项目对此有明确铁律。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const CORPUS = path.join(repoRoot, "src/data/tcm-classic-text-evidence-books.jsonl");

let checks = 0;
const failures = [];
const ok = (label, condition) => { checks += 1; if (!condition) failures.push(label); };

if (!fs.existsSync(CORPUS)) {
  // 语料是可选构建产物（外部输入），缺失不阻断——但必须说出来，不能静默通过。
  console.log("[test:book-corpus-evidence] 语料未构建，跳过（生成器 scripts/build-tcm-book-corpus-evidence.mjs）");
  process.exit(0);
}

const rows = fs.readFileSync(CORPUS, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
ok(`语料非空（${rows.length} 条）`, rows.length > 0);

// ── ① 危险内容零漏出 ────────────────────────────────────────────────────────
// 与构建期 DANGEROUS 规则同源；这里独立重写一份是**刻意的**：构建期漏了，运行期这条要拦得住。
const DANGEROUS = [
  { code: "带克数药膳", re: /[0-9]+\s*克[^。；]{0,40}(?:只|个|适量|洗净|切片|切块|炖|煮|熬|蒸|加水|文火|武火)/ },
  { code: "炼丹矿物毒药剂量", re: /(?:丹砂|朱砂|雄黄|水银|轻粉|铅丹|密陀僧|砒霜|信石)[^。；]{0,20}(?:[0-9〇零一二三四五六七八九十百半]+\s*(?:两|兩|钱|錢|铢|銖|克|g|分)|炼|煅|升华)/ },
  { code: "食疗映射西医病名", re: /(?:适宜于|适用于|可治疗|主治)[^。；]{0,25}(?:冠心病|高血压|糖尿病|心律不齐|心绞痛|癌|肿瘤|艾滋|乙肝)/ },
];
for (const rule of DANGEROUS) {
  const hits = rows.filter((row) => rule.re.test(String(row.text || "")));
  ok(`① 危险内容零漏出: ${rule.code}（实得 ${hits.length}）`, hits.length === 0);
  if (hits.length) failures.push(`  样例: ${String(hits[0].text).slice(0, 60)}`);
}

// ── ② 剂量零泄漏（过运行期脱敏后） ───────────────────────────────────────────
const source = fs.readFileSync(path.join(repoRoot, "src/lib/tcm-classic-evidence.server.ts"), "utf8");
const collisions = source.match(/const CLASSIC_RUNTIME_HERB_NAME_COLLISIONS = "([^"]+)"/)?.[1];
const body = source.match(/new RegExp\(\s*`([\s\S]*?)`\s*\+\s*"([\s\S]*?)",\s*\n\s*"gi",\s*\n\s*\);/);
assert.ok(collisions && body, "取不到运行期脱敏正则——实现结构变了，先更新本测试");
const sanitizer = new RegExp(
  body[1].replace("${CLASSIC_RUNTIME_HERB_NAME_COLLISIONS}", collisions).replaceAll("\\\\", "\\") + body[2],
  "gi",
);
const DOSE = /(?:\d+(?:\.\d+)?|[〇零一二三四五六七八九十百半]+)\s*(?:克|g|钱|錢|两|兩|铢|銖)/;
const leaked = rows.filter((row) => DOSE.test(String(row.text || "").replace(sanitizer, "[X]")));
ok(`② 脱敏后剂量零残留（实得 ${leaked.length}）`, leaked.length === 0);
if (leaked.length) failures.push(`  样例: ${String(leaked[0].text).slice(0, 80)}`);

// ── ③ 证据等级：不得压过受治理经典条文 ───────────────────────────────────────
ok("③ 全部条目 tier=book", rows.every((row) => row.tier === "book"));
const tierRankLine = source.match(/const tierRank = \{([^}]*)\}/)?.[1] || "";
const bookRank = Number(tierRankLine.match(/book:\s*(\d+)/)?.[1] ?? -1);
const maxGoverned = Math.max(
  Number(tierRankLine.match(/canon:\s*(\d+)/)?.[1] ?? 0),
  Number(tierRankLine.match(/common:\s*(\d+)/)?.[1] ?? 0),
  Number(tierRankLine.match(/experience:\s*(\d+)/)?.[1] ?? 0),
);
ok(`③ book 排序在受治理来源之后（book=${bookRank} > max(governed)=${maxGoverned}）`, bookRank > maxGoverned);

// ── ④ 方名键控必须真实存在于受治理目录 ───────────────────────────────────────
const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, "src/data/tcm-formula-governed-catalog.json"), "utf8"));
const governedNames = new Set();
for (const entry of catalog.entries) {
  governedNames.add(entry.name);
  for (const alias of entry.aliases || []) governedNames.add(alias);
}
const bogus = rows.filter((row) => (row.formulas || []).some((name) => !governedNames.has(name)));
ok(`④ 方名键控全部来自受治理目录（越界 ${bogus.length}）`, bogus.length === 0);
ok("④ 无空方名条目（无方名的条目永远查不到，不该入库）", rows.every((row) => (row.formulas || []).length > 0));

// ── ⑤ 运行期：未命中方名仍返回空，不得被新语料填充 ───────────────────────────
const jiti = createJiti(import.meta.url, {
  jsx: true, interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { classicEvidenceForFormulaNames, classicEvidenceCorpusStatus } =
  await jiti.import("../src/lib/tcm-classic-evidence.server.ts");
for (const nonsense of [["不存在的方名甲乙丙"], ["zzzz"], [""]]) {
  ok(`⑤ 未命中方名返回空: ${JSON.stringify(nonsense)}`, classicEvidenceForFormulaNames(nonsense).length === 0);
}
const status = classicEvidenceCorpusStatus();
const bookStatus = status.find((item) => item.name === "tcm-classic-text-evidence-books.jsonl");
ok("⑤ 语料已被加载器登记（漏登记会静默少一批证据）", Boolean(bookStatus));
ok(`⑤ 加载条数与文件一致（${bookStatus?.records} vs ${rows.length}）`, bookStatus?.records === rows.length);

if (failures.length > 0) {
  console.error("[test:book-corpus-evidence] 失败项：");
  for (const item of failures) console.error("  - " + item);
}
assert.equal(failures.length, 0, `${failures.length}/${checks} 项失败`);
console.log(`[test:book-corpus-evidence] OK — ${checks} 项断言全过；${rows.length} 条书籍语料证据`);
