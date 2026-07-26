// 10 部方书抽取结果 → 治理合并入库（与医方集解同规则）
// clean（无未命中药味）→ supplements 合并；flagged → 自纠队列；SZJG 双源跳过；已有条目合并不覆盖。
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
// 与抽取脚本同批次口径：BOOK_BATCH=温病批 时读 wenbing 目录，复核队列也各自成表，
// 否则温病批会覆盖方书批已有的 1343 条待复核。
const BATCH_DIR_SLUG = { 温病批: "tcmoc-formula-extract-wenbing", 方书二批: "tcmoc-formula-extract-books2", 救援批: "tcmoc-formula-extract-rescued" };
const BATCH_DIR = BATCH_DIR_SLUG[process.env.BOOK_BATCH] || "tcmoc-formula-extract-books";
const SRCDIR = resolve(ROOT, `artifacts/${BATCH_DIR}`);
const SUPP = resolve(ROOT, "src/data/tcm-verified-formula-supplements.json");
const REVIEW = resolve(ROOT, `artifacts/${BATCH_DIR}/governance-review-queue.json`);

const szjg = JSON.parse(readFileSync(resolve(ROOT, "src/data/szjg-tcm-formula-standard.json"), "utf-8"));
const szjgNames = new Set((szjg.entries || []).map((e) => e.name));
const supp = JSON.parse(readFileSync(SUPP, "utf-8"));
const ADJUVANT = new Set(["甘草", "炙甘草", "生姜", "大枣", "姜", "枣"]);

// 方名形状守卫。抽取器是按 <篇名> 切条目的，而方书里大量篇名是**论述/证治/条辨**而不是方剂
// （「中暑论」「伏暑条辨第十三」「伤风痧脉辨」「六、黑苔」，甚至「侦探」）。这些条目一旦入库，
// 就会以「方剂」身份进入检索候选，占掉短名单名额；身份锁虽然拦得住开方，但医生看到的
// 候选列表里会混入根本不存在的方。实测温病批入库后补充表里有 220 条这类条目，全部来自自动抽取。
// 这里只做**形状**判断，不做语义判断：不以受控剂型后缀结尾的一律不入库，改进复核队列。
// 宁可漏掉少数不以常见后缀命名的真方（它们会在复核队列里被人看到），也不能让篇名冒充方名。
const FORMULA_NAME_SHAPE = /(?:汤|丸|散|丹|膏|饮|煎|饮子|汁|粥|茶|酒|露|霜|锭|片|栓|方|子)$/;

// 身份归一（与 scripts/test-clinical-governance-tables.mjs 的 T8 normalized identity 同口径）:
// 剥《书名》级前缀/标点后,《千金》内补散 与 内补散 会归一成同一身份——实测方书二批
// 就把这对**组成完全不同**的同名异方同时放进补充表,运行身份唯一性测试当场变红。
// 文本名不同但归一身份相同的,一律改进复核队列走同名异方裁定(加味逍遥散模式),不许共存。
const identityKey = (value) => String(value || "").normalize("NFKC")
  .replace(/[（(]?\s*《[^》]{2,80}》\s*[）)]?/g, "")
  .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "")
  .replace(/(?:加减方?|化裁方?|加味方?)$/g, "")
  .trim();
const existingIdentities = new Map();
for (const n of Object.keys(supp.entries)) existingIdentities.set(identityKey(n), n);
for (const n of szjgNames) existingIdentities.set(identityKey(n), n);

const files = readdirSync(SRCDIR).filter((f) => f.endsWith(".jsonl") && !f.startsWith("_"));
const stats = { books: {}, clean: 0, flagged: 0, imported: 0, merged: 0, skippedSzjg: 0, skippedDup: 0, failed: 0 };
const review = [];
const seen = new Map(); // name -> {book, herbs, indications}
for (const file of files) {
  // 逐行过滤空串：某部书零产出时文件只有一个换行，"".trim().split("\n") 得到 [""]，
  // JSON.parse("") 直接抛异常，整批导入中断。抽取端存在零产出的书（无 <篇名> 标记的现代整理本），
  // 导入端就必须容得下空文件。
  const rows = readFileSync(resolve(SRCDIR, file), "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  let bookClean = 0, bookFlagged = 0, bookFailed = 0;
  for (const r of rows) {
    if (!r.ok) { bookFailed++; stats.failed++; continue; }
    const j = r.extracted;
    // 卷次序号尾缀:古方汇精等书同名列（一）（二）（三）为并列变体方。括注尾缀会被
    // 形状守卫误杀(不以剂型字结尾)、又会在 T8 身份归一(剥括注)下互相撞身份。
    // 改写为汉字直缀:拔疔散（二）→ 拔疔散二——形状可读、身份互异、同名列保留。
    const name = String(j.name || r.chapter).trim().replace(/（([一二三四五六七八九十百]+|\d+)）$/, "$1");
    const herbs = [...new Set((j.composition || []).map((c) => String(c.herb || "").trim()).filter(Boolean))];
    // 形状判断在剥掉卷次数字的裸名上做(拔疔散二→拔疔散),但入库身份保留数字以区分同名列变体。
    const nameForShapeTest = name.replace(/(?:[一二三四五六七八九十百]+|\d+)$/, "");
    if (!FORMULA_NAME_SHAPE.test(nameForShapeTest)) {
      bookFlagged++; stats.flagged++;
      review.push({ book: r.book, chapter: r.chapter, reason: `name-not-formula-shaped:${name}` });
      continue;
    }
    if (AGGREGATION_CHAPTER_NAME.test(nameForShapeTest)) {
      bookFlagged++; stats.flagged++;
      review.push({ book: r.book, chapter: r.chapter, reason: `aggregation-chapter-needs-splitting:${name}` });
      continue;
    }
    if (herbs.length < 2) { bookFlagged++; stats.flagged++; review.push({ book: r.book, chapter: r.chapter, reason: "composition<2" }); continue; }
    if (r.unmatchedHerbs.length > 0) {
      bookFlagged++; stats.flagged++;
      review.push({ book: r.book, chapter: r.chapter, reason: `unmatched:${r.unmatchedHerbs.join("、")}` });
      continue;
    }
    bookClean++; stats.clean++;
    if (szjgNames.has(name)) { stats.skippedSzjg++; continue; } // SZJG 基线优先
    if (seen.has(name)) { stats.skippedDup++; continue; } // 本批内重名（多部书同方，取先到者）
    // 归一身份碰撞:文本名不同但归一身份与既有条目相同 → 同名异方候选,进复核队列裁定,
    // 不允许两版同身份方共存(参见仙传内补散 vs 《千金》内补散,组成完全不同的实例)。
    const collided = existingIdentities.get(identityKey(name));
    if (collided && collided !== name) {
      bookFlagged++; stats.flagged++;
      review.push({ book: r.book, chapter: r.chapter, reason: `identity-collision:${name}↔${collided}` });
      continue;
    }
    seen.set(name, true);
    existingIdentities.set(identityKey(name), name);
    const required = herbs.filter((h) => !ADJUVANT.has(h)).slice(0, 3);
    const indications = [j.indications, j.analysis].filter((s) => typeof s === "string" && s.trim()).slice(0, 3);
    const verification = [{ title: `《${r.book}》·${r.chapter}（tcmoc 原文 + v4flash 抽取 + 全文对拍核验）`, url: `urn:tcm-cdss:tcmoc-books:${file.replace(/\.jsonl$/, "")}:${r.chapter}` }];
    if (supp.entries[name]) {
      const cur = supp.entries[name];
      const merged = [...(cur.indications || []), ...indications.filter((i) => !(cur.indications || []).includes(i))];
      supp.entries[name] = { ...cur, indications: merged };
      stats.merged++;
    } else {
      supp.entries[name] = {
        source: j.source ? String(j.source) : `《${r.book}》`,
        indications,
        ingredients: herbs,
        requiredIngredients: required.length >= 2 ? required : herbs.slice(0, 3),
        verification,
      };
      stats.imported++;
    }
  }
  stats.books[file.replace(/\.jsonl$/, "")] = { clean: bookClean, flagged: bookFlagged, failed: bookFailed };
}
writeFileSync(SUPP, JSON.stringify(supp, null, 2) + "\n");
writeFileSync(REVIEW, JSON.stringify(review, null, 2) + "\n");
console.log(JSON.stringify(stats, null, 1));
console.log("supplementEntries:", Object.keys(supp.entries).length);
