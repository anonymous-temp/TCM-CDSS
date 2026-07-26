// unmatched 队列重验救援器:用「仅验证域变体表」重验 1,894 条对拍未命中条目。
// 变体表纪律(与 T9 全局归一不同):只回答「模型声明的这味药,原文是否以变体写法支持」,
// 不做全局身份归一;歧义单字(术/芍/故纸)带语境守卫,不产歧义才认。
// 救援产物 = 与原抽取同构的 JSONL(unmatchedHerbs 已清零),走既有 import 管线入库。
// 用法: node scripts/ingest/unmatched-reverify-rescue.mjs
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const BOOKS_DIR = resolve(ROOT, "中医补充数据/tcmoc-master/books");
const OUTDIR = resolve(ROOT, "artifacts/tcmoc-formula-extract-rescued");
mkdirSync(OUTDIR, { recursive: true });

// 仅验证域变体表(证据:artifacts/unmatched-variant-analysis.json 的高频共现)
const VARIANTS = {
  川芎: ["芎"], 牡丹皮: ["丹皮"], 玄参: ["元参"], 酸枣仁: ["枣仁"], 山茱萸: ["山萸", "萸肉"],
  黄连: ["连"], 黄芩: ["芩"], 葛根: ["葛"], 萆薢: ["萆"], 藁本: ["本"],
  当归尾: ["归尾"], 当归身: ["归身"], 补骨脂: ["破故纸"], 生姜: ["姜"], 大枣: ["枣"],
  肉桂: ["官桂", "桂心"], 肉苁蓉: ["苁蓉"], 巴戟天: ["巴戟"], 泽泻: ["泽"],
  甘草: ["草"], 炙甘草: ["炙草"], 朱砂: ["辰砂", "丹砂"], 麝香: ["麝"], 厚朴: ["朴", "浓朴"],
  当归: ["归"], 桔梗: ["桔"], 桑白皮: ["桑皮"], 枳壳: ["枳"], 薏苡仁: ["苡仁", "薏米"],
  熟地黄: ["熟地"], 天花粉: ["栝蒌根", "瓜蒌根"], 地骨皮: ["骨皮"], 牛蒡子: ["鼠粘子", "牛蒡"],
  茯苓: ["云苓", "茯"], 旋覆花: ["旋复花"], 龟甲: ["龟板"], 荆芥: ["芥"], 磁石: ["磁"],
  薄荷: ["荷"], 蝉蜕: ["蝉衣"], 鳖甲: ["鳖"], 半夏: ["夏"], 山栀: ["栀"], 知母: ["母"],
  款冬花: ["款冬"], 金银花: ["银花", "双花"], 白鲜皮: ["白藓皮"], 僵蚕: ["姜蚕"],
  黄芪: ["黄耆"], 全蝎: ["全虫"], 乌梢蛇: ["乌蛇"], 白花蛇: ["蕲蛇"],
};
// 歧义守卫:声明 X 且源段出现变体,但同段出现竞争词时该变体作废
const GUARDS = {
  白术: { variants: ["术"], competitors: ["苍术"] },
  白芍: { variants: ["芍"], competitors: ["赤芍", "赤芍药"] },
  补骨脂: { variants: ["故纸"], competitors: ["木蝴蝶", "千张纸"] },
};

const t9 = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-herb-identity-catalog.json"), "utf-8"));
const ri = t9.resolutionIndex;
function herbInText(herb, text) {
  if (!herb) return false;
  if (text.includes(herb)) return true;
  for (const suf of ["子", "仁", "皮", "肉", "片", "炭", "末", "萸", "黄", "苓", "芍", "草", "参", "归", "芎", "朴", "芪", "桂", "母", "星", "夏", "枳", "姜", "枣"]) {
    if (herb.endsWith(suf) && text.includes(herb.slice(0, -1))) return true;
  }
  const v = ri[herb];
  if (v?.canonicalName && text.includes(v.canonicalName)) return true;
  for (const a of v?.aliases || []) if (text.includes(a)) return true;
  for (const x of VARIANTS[herb] || []) if (text.includes(x)) return true;
  const g = GUARDS[herb];
  if (g && !g.competitors.some((c) => text.includes(c))) {
    for (const x of g.variants) if (text.includes(x)) return true;
  }
  return false;
}

const bookFile = new Map();
for (const f of readdirSync(BOOKS_DIR)) {
  const m = f.match(/^\d+-(.+)\.txt$/);
  if (m) bookFile.set(m[1], f);
}
const rawCache = new Map();
function sectionsOf(book) {
  if (!rawCache.has(book)) {
    const raw = readFileSync(resolve(BOOKS_DIR, bookFile.get(book)), "utf-8");
    const map = new Map();
    for (const s of raw.split(/<篇名>/).slice(1)) {
      const nl = s.indexOf("\n");
      map.set(s.slice(0, nl).trim(), s.slice(nl + 1).replace(/<目录>[^\n]*/g, "").trim());
    }
    rawCache.set(book, map);
  }
  return rawCache.get(book);
}
function sectionText(book, chapter) {
  if (!bookFile.has(book)) return undefined;
  const map = sectionsOf(book);
  if (map.has(chapter)) return map.get(chapter);
  for (const [k, v] of map) if (k.includes(chapter) || chapter.includes(k)) return v;
  return undefined;
}

const stats = { rows: 0, rescued: 0, stillUnmatched: 0, noSection: 0, perHerbRescued: {} };
const rescuedByBook = new Map();
for (const batch of ["books", "wenbing", "books2"]) {
  const dir = resolve(ROOT, `artifacts/tcmoc-formula-extract-${batch}`);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl") && !x.startsWith("_"))) {
    const rows = readFileSync(resolve(dir, f), "utf-8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    const rescued = [];
    for (const r of rows) {
      if (!r.ok || !(r.unmatchedHerbs || []).length) continue;
      stats.rows++;
      const text = sectionText(r.book, r.chapter) || "";
      const still = r.unmatchedHerbs.filter((h) => !herbInText(h, text));
      if (!text) stats.noSection++;
      if (still.length === 0) {
        stats.rescued++;
        for (const h of r.unmatchedHerbs) stats.perHerbRescued[h] = (stats.perHerbRescued[h] || 0) + 1;
        rescued.push({ ...r, unmatchedHerbs: [], rescuedVia: "variant-reverify-20260725" });
      } else {
        stats.stillUnmatched++;
      }
    }
    if (rescued.length) rescuedByBook.set(f, rescued);
  }
}
for (const [f, rows] of rescuedByBook) {
  writeFileSync(resolve(OUTDIR, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
console.log(JSON.stringify({ ...stats, perHerbRescued: Object.fromEntries(Object.entries(stats.perHerbRescued).sort((a, b) => b[1] - a[1]).slice(0, 25)) }));
