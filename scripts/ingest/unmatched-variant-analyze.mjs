// 对拍未命中变体分析器:对 1,894 条 unmatched 队列,回源段统计「声明药名→源段实际写法」的
// 高频共现对,为 T9 别名补充表提供证据底稿。
// 用法: node scripts/ingest/unmatched-variant-analyze.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const BOOKS_DIR = resolve(ROOT, "中医补充数据/tcmoc-master/books");

const bookFile = new Map();
for (const f of readdirSync(BOOKS_DIR)) {
  const m = f.match(/^\d+-(.+)\.txt$/);
  if (m) bookFile.set(m[1], f);
}
const sectionCache = new Map();
function sectionText(book, chapter) {
  if (!bookFile.has(book)) return undefined;
  if (!sectionCache.has(book)) {
    const raw = readFileSync(resolve(BOOKS_DIR, bookFile.get(book)), "utf-8");
    const map = new Map();
    for (const s of raw.split(/<篇名>/).slice(1)) {
      const nl = s.indexOf("\n");
      map.set(s.slice(0, nl).trim(), s.slice(nl + 1).replace(/<目录>[^\n]*/g, "").trim());
    }
    sectionCache.set(book, map);
  }
  const map = sectionCache.get(book);
  if (map.has(chapter)) return map.get(chapter);
  for (const [k, v] of map) if (k.includes(chapter) || chapter.includes(k)) return v;
  return undefined;
}

// 候选变体生成:对每个声明药名,枚举源段可能写法,再统计命中。
const t9 = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-herb-identity-catalog.json"), "utf-8"));
const ri = t9.resolutionIndex;
function variantsFor(herb) {
  const vs = new Set();
  const v = ri[herb];
  if (v?.canonicalName) vs.add(v.canonicalName);
  for (const a of v?.aliases || []) vs.add(a);
  // 常见古籍写法规则(只在统计层使用,入库仍需证据)
  const rules = {
    肉桂: ["官桂", "桂心", "桂皮", "牡桂"], 山茱萸: ["山萸", "萸肉"], 牡丹皮: ["丹皮"],
    玄参: ["元参"], 熟地黄: ["熟地", "熟地黄"], 甘草: ["炙草", "生草", "草"],
    川芎: ["芎", "川芑"], 黄芪: ["黄耆", "耆"], 当归: ["归"], 白芍: ["芍"],
    茯苓: ["茯", "云苓", "白茯苓"], 白术: ["术"], 半夏: ["夏"], 黄芩: ["芩"],
    黄连: ["连"], 大黄: ["黄"], 厚朴: ["浓朴", "朴"], 枳壳: ["枳"], 陈皮: ["橘皮"],
    生姜: ["姜"], 大枣: ["枣"], 朱砂: ["辰砂", "丹砂"], 麝香: ["麝"],
    补骨脂: ["故纸", "破故纸"], 天花粉: ["瓜蒌根", "栝蒌根"], 金银花: ["双花", "银花"],
    巴戟天: ["巴戟"], 肉苁蓉: ["苁蓉"], 萆薢: ["萆"], 藁本: ["本"], 薏苡仁: ["苡仁", "薏米"],
    酸枣仁: ["枣仁"], 柏子仁: ["柏仁"], 杏仁: ["杏"], 桃仁: ["桃"], 葛根: ["葛"],
    泽泻: ["泽"], 猪苓: ["猪"], 滑石: ["石"], 石膏: ["石"], 知母: ["母"],
    山栀: ["栀"], 桔梗: ["桔"], 荆芥: ["芥"], 薄荷: ["荷"], 牛蒡子: ["牛蒡", "鼠粘子"],
    蝉蜕: ["蝉衣"], 僵蚕: ["姜蚕", "天虫"], 地龙: ["蚯蚓"], 全蝎: ["全虫"],
    蜈蚣: ["蚣"], 白花蛇: ["蕲蛇"], 乌梢蛇: ["乌蛇"], 龟甲: ["龟板"], 鳖甲: ["鳖"],
    牡蛎: ["蛎"], 珍珠母: ["珠母"], 石决明: ["决明"], 磁石: ["磁"], 代赭石: ["赭石"],
    旋覆花: ["旋复花"], 款冬花: ["款冬"], 紫菀: ["菀"], 百部: ["百"],
    桑白皮: ["桑皮"], 地骨皮: ["骨皮"], 白鲜皮: ["白藓皮"], 苦参: ["苦"],
    龙胆草: ["龙胆"], 夏枯草: ["夏枯"], 决明子: ["决明"], 谷精草: ["谷精"],
    密蒙花: ["密蒙"], 青葙子: ["青葙"], 夜明砂: ["夜明"], 望月砂: ["望月"],
    当归尾: ["归尾"], 当归身: ["归身"], 当归头: ["归头"],
  };
  for (const x of rules[herb] || []) vs.add(x);
  return [...vs].filter((x) => x && x !== herb);
}

const queues = [];
for (const batch of ["books", "wenbing", "books2"]) {
  const q = JSON.parse(readFileSync(resolve(ROOT, `artifacts/tcmoc-formula-extract-${batch}/governance-review-queue.json`), "utf-8"));
  for (const it of q) {
    const r = it.reason || "";
    if (r.startsWith("unmatched:")) {
      queues.push({ batch, book: it.book, chapter: it.chapter, herbs: r.slice(10).split("、").map((s) => s.trim()).filter(Boolean) });
    }
  }
}
console.log(JSON.stringify({ unmatchedItems: queues.length }));

const pairCount = new Map(); // "herb|variant" -> count
const herbUnsolved = new Map(); // herb -> count (无变体命中)
let noSection = 0;
for (const it of queues) {
  const text = sectionText(it.book, it.chapter);
  if (!text) { noSection++; continue; }
  for (const herb of it.herbs) {
    const hits = variantsFor(herb).filter((v) => text.includes(v));
    if (hits.length) {
      for (const h of hits) pairCount.set(`${herb}|${h}`, (pairCount.get(`${herb}|${h}`) || 0) + 1);
    } else {
      herbUnsolved.set(herb, (herbUnsolved.get(herb) || 0) + 1);
    }
  }
}
const topPairs = [...pairCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
const topUnsolved = [...herbUnsolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
console.log("高频 药名→源段写法 对:");
for (const [k, c] of topPairs) console.log(`  ${k} × ${c}`);
console.log("无变体命中的药名 TOP:");
for (const [k, c] of topUnsolved) console.log(`  ${k} × ${c}`);
console.log("无源段:", noSection);
writeFileSync(resolve(ROOT, "artifacts/unmatched-variant-analysis.json"), JSON.stringify({ pairs: topPairs, unsolved: topUnsolved, noSection }, null, 2) + "\n");
