// 10 部方书抽取结果 → 治理合并入库（与医方集解同规则）
// clean（无未命中药味）→ supplements 合并；flagged → 自纠队列；SZJG 双源跳过；已有条目合并不覆盖。
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRCDIR = resolve(ROOT, "artifacts/tcmoc-formula-extract-books");
const SUPP = resolve(ROOT, "src/data/tcm-verified-formula-supplements.json");
const REVIEW = resolve(ROOT, "artifacts/tcmoc-formula-extract-books/governance-review-queue.json");

const szjg = JSON.parse(readFileSync(resolve(ROOT, "src/data/szjg-tcm-formula-standard.json"), "utf-8"));
const szjgNames = new Set((szjg.entries || []).map((e) => e.name));
const supp = JSON.parse(readFileSync(SUPP, "utf-8"));
const ADJUVANT = new Set(["甘草", "炙甘草", "生姜", "大枣", "姜", "枣"]);

const files = readdirSync(SRCDIR).filter((f) => f.endsWith(".jsonl") && !f.startsWith("_"));
const stats = { books: {}, clean: 0, flagged: 0, imported: 0, merged: 0, skippedSzjg: 0, skippedDup: 0, failed: 0 };
const review = [];
const seen = new Map(); // name -> {book, herbs, indications}
for (const file of files) {
  const rows = readFileSync(resolve(SRCDIR, file), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  let bookClean = 0, bookFlagged = 0, bookFailed = 0;
  for (const r of rows) {
    if (!r.ok) { bookFailed++; stats.failed++; continue; }
    const j = r.extracted;
    const name = String(j.name || r.chapter).trim();
    const herbs = [...new Set((j.composition || []).map((c) => String(c.herb || "").trim()).filter(Boolean))];
    if (herbs.length < 2) { bookFlagged++; stats.flagged++; review.push({ book: r.book, chapter: r.chapter, reason: "composition<2" }); continue; }
    if (r.unmatchedHerbs.length > 0) {
      bookFlagged++; stats.flagged++;
      review.push({ book: r.book, chapter: r.chapter, reason: `unmatched:${r.unmatchedHerbs.join("、")}` });
      continue;
    }
    bookClean++; stats.clean++;
    if (szjgNames.has(name)) { stats.skippedSzjg++; continue; } // SZJG 基线优先
    if (seen.has(name)) { stats.skippedDup++; continue; } // 本批内重名（多部书同方，取先到者）
    seen.set(name, true);
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
