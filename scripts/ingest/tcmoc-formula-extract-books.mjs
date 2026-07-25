// v4 flash 方证批量抽取（多书通用版）：方书批 → 结构化方证 JSONL + 全文对拍
// 用法: DEEPSEEK_API_KEY=sk-... node scripts/ingest/tcmoc-formula-extract-books.mjs [并发] [书序号起] [书序号止]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const BOOKS_DIR = resolve(ROOT, "中医补充数据/tcmoc-master/books");
// 产出按批次分目录，否则温病批会覆盖方书批已有的复核队列与抽取结果。
const OUTDIR_SLUG = { 方书批: "books", 温病批: "wenbing", 方书二批: "books2" };
const OUTDIR = resolve(ROOT, `artifacts/tcmoc-formula-extract-${OUTDIR_SLUG[process.env.BOOK_BATCH || "方书批"] || "books"}`);
mkdirSync(OUTDIR, { recursive: true });
// 密钥只从环境变量读，不写入任何文件。项目 .env.local 里配的是 OPENAI_API_KEY（base_url 指向 deepseek），
// 因此两个都接受，用 `node --env-file-if-exists=.env.local` 注入即可，无需在命令行里明文粘贴。
const KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY or OPENAI_API_KEY required");
const CONC = Number(process.argv[2] || 4);
const BOOK_START = Number(process.argv[3] || 0);
const BOOK_END = Number(process.argv[4] || 999);

// 批次可切换：默认是散文体方书批（条文式条目结构，与医方集解同构）。
// 温病批走同一套抽取+对拍+治理流程——它们的条目结构同构，没有理由复制一份脚本；
// 复制出来的第二份迟早会和主线漂移，而漂移的是**方证抽取**这种直接影响处方的东西。
const BOOK_BATCHES = {
  方书批: [
    "091-成方切用.txt", "072-医方考.txt", "082-古今名医方论.txt", "639-删补名医方论.txt",
    "089-医方论.txt", "092-时方妙用.txt", "088-绛雪园古方选注.txt", "071-医方集宜.txt",
    "067-仁斋直指方论（附补遗）.txt", "558-三因极一病证方论.txt",
  ],
  // 温病批：T8 目录此前完全没有温病维度——三仁汤/甘露消毒丹/增液汤/神犀丹/薏苡竹叶散
  // 一首都不在 1800 首里，而原文就在库中且高度结构化（温病条辨实测 87 个篇名、195 个方名标记）。
  温病批: [
    "526-温病条辨.txt", "543-温热经纬.txt", "528-时病论.txt", "522-温疫论.txt",
    "525-疫疹一得.txt", "549-重订广温热论.txt", "527-温热逢源.txt", "529-温病指南.txt",
    "541-温病正宗.txt", "546-广瘟疫论.txt", "524-温热暑疫全书.txt", "433-六因条辨.txt",
    "509-湿热病篇.txt", "551-随息居重订霍乱论.txt", "652-三时伏气外感篇.txt",
    "139-痧疹辑要.txt", "591-痧胀玉衡.txt", "179-专治麻痧初编.txt", "544-温热论.txt",
  ],
  // 方书二批：切片器 FORMULA_BOOK_PREFIXES 39 部中剩余的散文体方书（28 部剩余 = 15 散文 +
  // 10 歌诀 + 499 金匮要略方论 + 651 引经药歌 + 689 百家针灸歌赋）。
  //   歌诀 10 部走 verse-book-indication-extract.mjs（确定性，组成助记型不该按方证条目抽）；
  //   499 金匮要略方论的篇名是「病脉证治」章节而非方名，按条目抽必然重蹈温病批篇名污染，
  //       其方证已由 T8 经方基线 + T15 条文证据 + 金匮方歌括主治三重覆盖，不抽；
  //   651 引经药歌是药性歌诀、689 是针灸歌赋，均非方剂语料，不进本管线。
  // 499/651/689 的处置依据记录在 docs/中医补充数据-盘点与接入方案-20260725.md。
  方书二批: [
    "062-洪氏集验方.txt", "068-瑞竹堂经验方.txt", "097-验方新编.txt", "104-集验方.txt",
    "105-大小诸证方论.txt", "110-惠直堂经验方.txt", "113-古方汇精.txt", "115-文堂集验方.txt",
    "122-医方简义.txt", "152-小儿痘疹方论.txt", "184-麻疹备要方论.txt", "190-毓麟验方.txt",
    "220-外科集验方.txt", "284-仙传外科集验方.txt", "619-验方家秘.txt",
  ],
};
const BATCH = process.env.BOOK_BATCH || "方书批";
if (!BOOK_BATCHES[BATCH]) throw new Error(`unknown BOOK_BATCH: ${BATCH}（可选：${Object.keys(BOOK_BATCHES).join("/")}）`);
const BOOKS = BOOK_BATCHES[BATCH].slice(BOOK_START, BOOK_END);

const FORMULA_CHAPTER = /(?:汤|丸|散|丹|膏|饮|方|煎|饮子|汁|粥|茶|酒|露|霜|锭|片|栓)$/;

function parseBook(file) {
  const raw = readFileSync(resolve(BOOKS_DIR, file), "utf-8");
  const title = (raw.slice(0, 800).match(/书名：([^\n]+)/) || [])[1]?.trim() || file.replace(/^\d+-|\.txt$/g, "");
  const sections = raw.split(/<篇名>/).slice(1)
    .map((s) => {
      const nl = s.indexOf("\n");
      return { chapter: s.slice(0, nl).trim(), body: s.slice(nl + 1).replace(/<目录>[^\n]*/g, "").trim() };
    })
    .filter((s) => s.chapter && s.body.length > 60)
    .filter((s) => FORMULA_CHAPTER.test(s.chapter) || s.body.includes("治"));
  return { title, sections };
}

const mkSystem = (book) => `你是中医古籍方证结构化抽取器。输入《${book}》的一个方剂条目（含 OCR 丢字），输出单个 JSON 对象，不要输出任何其他文字。
字段:
- name: 方名（条目篇名）
- source: 出处（条目内"（《xx》）"类，无则 null）
- composition: [{"herb":"规范药名","dose":"原文剂量或null","processing":"炮制或null"}]，只能包含原文组成行实际出现的药味；OCR 丢字按上下文修复并记录 ocrRepairs
- indications: 主治（原文摘要，≤80字）
- usage: 煎服法/用法（无则 null）
- modifications: [{"trigger":"原文加减条件","action":"加/减/换药名"}]
- analysis: 方义归经要点（≤60字）
- ocrRepairs: ["原样→修复样"]
要求：只输出 JSON；宁可少抽也绝不凭记忆补充药味；拿不准写 null。`;

async function callApi(book, entry, attempt = 0) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: mkSystem(book) },
        { role: "user", content: `条目篇名：${entry.chapter}\n\n${entry.body.slice(0, 2200)}` },
      ],
      temperature: 0, max_tokens: 2200, thinking: { type: "disabled" }, stream: false,
    }),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return callApi(book, entry, attempt + 1);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || "";
  const lb = text.indexOf("{"), rb = text.lastIndexOf("}");
  if (lb < 0 || rb < 0) throw new Error(`no json: ${text.slice(0, 100)}`);
  return JSON.parse(text.slice(lb, rb + 1));
}

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
  if (herb.startsWith("熟地") && text.includes("熟地")) return true;
  if (herb === "厚朴" && text.includes("浓朴")) return true;
  return false;
}

const summary = {};
for (const file of BOOKS) {
  const { title, sections } = parseBook(file);
  const out = [];
  const queue = [...sections];
  let ok = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      try {
        const j = await callApi(title, entry);
        const bad = (j.composition || []).filter((c) => c.herb && !herbInText(c.herb, entry.body)).map((c) => c.herb);
        out.push({ book: title, chapter: entry.chapter, ok: true, unmatchedHerbs: bad, extracted: j, sourceText: entry.body.slice(0, 300) });
        ok++;
      } catch (e) {
        out.push({ book: title, chapter: entry.chapter, ok: false, error: String(e).slice(0, 160) });
      }
    }
  }));
  out.sort((a, b) => a.chapter.localeCompare(b.chapter, "zh"));
  writeFileSync(resolve(OUTDIR, `${title}.jsonl`), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  summary[title] = { sections: sections.length, ok, unmatched: out.filter((r) => r.ok && r.unmatchedHerbs.length > 0).length };
  console.log(JSON.stringify({ book: title, ...summary[title] }));
}
writeFileSync(resolve(OUTDIR, "_summary.json"), JSON.stringify(summary, null, 2) + "\n");
