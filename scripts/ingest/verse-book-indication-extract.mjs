/**
 * 歌诀类方书主治抽取（确定性，零模型调用）。
 *
 * 为什么不需要 verse 专用 prompt：先看结构再动手，发现长沙方歌括/金匮方歌括/时方歌括/
 * 退思集类方歌注 的主治就写在篇首、以「治…。」开头，位置在歌诀之前，正则即可抽取。
 *   桂枝汤   → 治自汗恶风。头疼体痛。发热。脉浮缓。名曰中风。
 *   补中益气汤 → 治阴虚内热。头痛口渴。表热自汗…
 * 实测 710 篇中 238 篇具备该结构（34%），全部零成本可得。
 *
 * ★ 汤头歌诀是例外，必须排除 ★
 * 它的歌诀是**组成助记**（「参术茯苓甘草比」）而非主治，主治零散在夹注里，
 * 101 篇仅 1 篇命中「治…」句。把它按同一规则抽取只会把组成当主治灌进检索语料。
 *
 * 输出：artifacts/verse-book-indications.json（候选，供人工/裁定通道审阅）
 * 合并语义：只对**目录中已存在**的方剂追加主治，绝不新建方剂、绝不覆盖既有主治条目。
 *   新建方剂需要走完整治理（来源、组成、剂量、证型标签），不是本脚本的职责。
 *
 * 源文件为 GB18030 编码，不是 UTF-8。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, basename } from "node:path";

const BOOKS_DIR = "中医补充数据/TCM-Ancient-Books-master";
/** 已验证主治写在篇首的书；汤头歌诀等组成助记型不得加入。 */
const INDICATION_LEADING_BOOKS = [
  "094-长沙方歌括",
  "095-金匮方歌括",
  "093-时方歌括",
  "102-退思集类方歌注",
];
const OUT = "artifacts/verse-book-indications.json";

const catalog = JSON.parse(readFileSync("src/data/tcm-formula-governed-catalog.json", "utf8"));
const catalogByName = new Map(catalog.entries.map((entry) => [entry.name, entry]));

/** 方名清洗：去掉「论/歌/方歌」等后缀与卷次标注，只保留方名本身。 */
function cleanFormulaName(raw) {
  return raw
    .replace(/[（(].*?[）)]/g, "")
    .replace(/(?:方歌括?|歌括?|论|方论|证治)$/g, "")
    .replace(/[\s·、，,。：:]/g, "")
    .trim();
}

/** 篇首主治句：以「治」起头、到句号止；排除明显不是主治的议论文起手。 */
const LEADING_INDICATION = /^\s*(治[^。]{3,80}。(?:[^。]{2,60}。){0,3})/;

const records = [];
const skipped = { noLeadingIndication: 0, notInCatalog: 0, alreadyPresent: 0 };

for (const file of readdirSync(BOOKS_DIR)) {
  const stem = basename(file, ".txt");
  if (!INDICATION_LEADING_BOOKS.includes(stem)) continue;
  const text = readFileSync(join(BOOKS_DIR, file)).toString("utf8") === ""
    ? ""
    : new TextDecoder("gb18030").decode(readFileSync(join(BOOKS_DIR, file)));
  const bookTitle = stem.replace(/^\d+-/, "");

  for (const match of text.matchAll(/<篇名>([^\n]{2,24})\n+属性：\s*([\s\S]{0,400}?)(?=\n*<目录>|\n*<篇名>|$)/g)) {
    const name = cleanFormulaName(match[1]);
    const body = match[2].replace(/\n/g, "");
    const indication = body.match(LEADING_INDICATION)?.[1]?.trim();
    if (!indication) { skipped.noLeadingIndication += 1; continue; }
    const entry = catalogByName.get(name);
    // 只补已受控方剂：新建方剂需要完整治理（组成/剂量/证型标签），不由本脚本承担。
    if (!entry) { skipped.notInCatalog += 1; continue; }
    // 已有同一条主治则不重复追加（合并不覆盖）。
    if ((entry.indications || []).some((item) => String(item).includes(indication.slice(0, 12)))) {
      skipped.alreadyPresent += 1;
      continue;
    }
    records.push({ formulaName: name, indication, source: `《${bookTitle}》`, sourceFile: file });
  }
}

const byFormula = {};
for (const record of records) {
  (byFormula[record.formulaName] ||= []).push(record);
}

if (!existsSync("artifacts")) mkdirSync("artifacts", { recursive: true });
writeFileSync(OUT, `${JSON.stringify({
  schemaVersion: "verse-book-indications-v1",
  generatedFrom: INDICATION_LEADING_BOOKS,
  excluded: { "084-汤头歌诀": "歌诀为组成助记而非主治，101 篇仅 1 篇含「治…」句，按同规则抽取会把组成灌进主治语料" },
  mergeSemantics: "additive_only_existing_formulas",
  summary: {
    extracted: records.length,
    distinctFormulas: Object.keys(byFormula).length,
    skipped,
  },
  records,
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  extracted: records.length,
  distinctFormulas: Object.keys(byFormula).length,
  skipped,
  out: OUT,
}, null, 2));
