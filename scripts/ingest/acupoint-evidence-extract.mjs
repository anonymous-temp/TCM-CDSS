// 《经络腧穴学》（"十三五"规划教材，TCM Educational Materials.txt 区段）→ T12 穴位证据表。
// 确定性解析，零模型调用——该段条目格式为教材排版级规整：
//   5.尺泽* Chǐzé（LU5）合穴
//   【定位】…【解剖】…【主治】（1）…（2）…【操作】…【古文献摘录】…
// 401 个【定位】标记 ≈ 361 经穴 + 经外奇穴。结构正则即可全量抽取，没有理由让 LLM
// 在国标级数据上引入幻觉风险（与 verse-book-indication-extract 的判定同一逻辑）。
// 用法: node scripts/ingest/acupoint-evidence-extract.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "中医补充数据/灵丹GitHub/TCM Educational Materials.txt");
const OUT = resolve(ROOT, "src/data/tcm-acupoint-evidence-catalog.json");
const REPORT = resolve(ROOT, "artifacts/acupoint-extract-report.json");
mkdirSync(dirname(REPORT), { recursive: true });

const raw = readFileSync(SRC, "utf-8");
// 区段定位：遍历每个版权页，取其后 600 字内含「经络腧穴学」的那个——书名本身会在
// 前一册《针灸医籍选读》的参考书目里提前出现，直接 indexOf(书名) 会定位到错误的区段。
const cipMark = "图书在版编目";
const titleMark = "经络腧穴学";
let segStart = -1;
for (let pos = -1; (pos = raw.indexOf(cipMark, pos + 1)) >= 0;) {
  if (raw.slice(pos, pos + 600).includes(titleMark)) { segStart = pos; break; }
}
if (segStart < 0) throw new Error("找不到《经络腧穴学》版权页");
const segEnd = raw.indexOf(cipMark, segStart + cipMark.length);
const seg = raw.slice(segStart, segEnd > 0 ? segEnd : undefined);

// 条目标题：序号.穴名[空格]*[空格]拼音（代码）特定穴类?
// 代码实测形态：LU5 / LI4 / ST36 / SP6 / HT7 / SI3 / BL40 / KI3 / PC6 / TE1（三焦经用 TE 不用 SJ）/
//   GB34 / LR4 / GV20（督脉用 GV 不用 DU）/ RN4 / EX-HN3 等；GVl6/GVl9 是 OCR 把 "16/19" 认成 "l6/l9"。
// 星号位置有两种排版：「天宗*Tiānzōng」（星后无空格）与「完骨 *Wángǔ」（星前有空格），两侧都允许。
// 拼音字符类必须覆盖到 U+024F：À-ž（U+00C0–017E）只到拉丁扩展 A 末尾,而拼音第三声
// 符号 ǎǐǒǔǖǘǚǜ 在 U+01CD–01DC（扩展 B 区）——漏了它们,凡带第三声的穴位
// （中府 Zhōngfǔ、足三里 Zúsānlǐ…~60 穴）会整条静默丢失。此处用 À-ɏ（U+00C0–024F）。
// 另有 ′（U+2032,臂臑 Bì′nào）与 ’（U+2019）两种撇号。
const ENTRY_RE = /(?:^|\n)\s*(\d{1,3})\.([一-龥]{1,5})\s*\*?\s*([A-Za-zÀ-ɏ'’′\s]{2,30}?)（((?:LU|LI|ST|SP|HT|SI|BL|KI|PC|SJ|TE|GB|LR|DU|GV|RN|CV|EX)(?:-[A-Z]{1,3})?[0-9l]+)）([^\n]{0,20})/g;
// 经脉归属以代码为准（权威且不受章节标题变体影响——第十五章「奇经八脉」统辖督任二脉,
// 章标题根本不含「督脉」字样,按章节归经必丢）。
const MERIDIAN_BY_PREFIX = {
  LU: "手太阴肺经", LI: "手阳明大肠经", ST: "足阳明胃经", SP: "足太阴脾经",
  HT: "手少阴心经", SI: "手太阳小肠经", BL: "足太阳膀胱经", KI: "足少阴肾经",
  PC: "手厥阴心包经", TE: "手少阳三焦经", SJ: "手少阳三焦经", GB: "足少阳胆经", LR: "足厥阴肝经",
  DU: "督脉", GV: "督脉", RN: "任脉", CV: "任脉", EX: "经外奇穴",
};
function pick(block, tag) {
  const m = block.match(new RegExp(`【${tag}】([\\s\\S]*?)(?=【|$)`));
  if (!m) return undefined;
  // 末穴条目没有下一个【】标记兜底,块尾会泄进下一章正文:在章标题或独占一行的图号处截断;
  // 各经末穴的【操作】后会泄进经脉循行注释([1]…[11] 脚注块)与下一节标题,一并截断。
  return m[1].split(/\n(?=第[一二三四五六七八九十百]+章)|\n图\d+-\d+-\d+\n|\s(?=第[一二三四五六七八九十百]+节[一-龥\s])|\s\[\d+\](?=[^\d])/)[0].replace(/\s+/g, " ").trim();
}
// 源文件用私用区字符替代生僻字:U+E81F 实为「㖞」（口眼㖞斜,37 处,全部在临床主治文本里,
// 必须修）;U+E83F 仅 2 处,出现在古文献注释中,保留原样并在测试里钉住位置。
const PUA_REPAIR = [[//g, "㖞"]];
function repairText(value) {
  if (typeof value === "string") {
    let out = value;
    for (const [re, rep] of PUA_REPAIR) out = out.replace(re, rep);
    return out;
  }
  if (Array.isArray(value)) return value.map(repairText);
  return value;
}
const entries = [];
const matches = [...seg.matchAll(ENTRY_RE)];
// 教材在文件中存在两个排版副本（上半/下半册各一套目录与正文）,同一代码会命中多次,
// 按代码去重,保留主治条目更全的那份。
const byCode = new Map();
for (let i = 0; i < matches.length; i += 1) {
  const m = matches[i];
  const blockEnd = i + 1 < matches.length ? matches[i + 1].index : Math.min(m.index + 3000, seg.length);
  const block = seg.slice(m.index, blockEnd);
  const location = pick(block, "定位");
  const indicationsRaw = pick(block, "主治");
  const operation = pick(block, "操作");
  if (!location || !indicationsRaw) continue; // 概述/目录/例题中的路过标题不具条目结构
  // 主治按（1）（2）（3）拆分;无编号时整段为一条
  const items = indicationsRaw.split(/（\d+）/).map((s) => s.replace(/[。\s]+$/, "").trim()).filter(Boolean);
  const classical = pick(block, "古文献摘录");
  const code = m[4].replace(/^GV/, "DU").replace(/^CV/, "RN").replace(/l/g, "1"); // GVl6→DU16: OCR l→1
  const entry = {
    code,
    name: m[2],
    pinyin: m[3].replace(/\s+/g, "").replace(/[’']/g, ""),
    meridian: MERIDIAN_BY_PREFIX[code.replace(/[^A-Z].*$/, "")],
    specialClass: m[5].trim() || undefined,
    location: repairText(location),
    indications: repairText(items),
    operation: operation ? repairText(operation) : undefined,
    classicalExcerpts: classical ? [repairText(classical.slice(0, 300))] : undefined,
    sourceRef: "SRC-TEXTBOOK-JINGLUO-SHUXUE", // 《经络腧穴学》“十三五”规划教材
  };
  const cur = byCode.get(entry.code);
  if (!cur || entry.indications.length > cur.indications.length) byCode.set(entry.code, entry);
}
entries.push(...byCode.values());

// 人工治理补充通道：教材奇穴章只收 37 穴（国家标准的安眠(EX-HN22)等不在选录范围）,
// 而既有 T12 模板引用了安眠。与方剂 supplements 同纪律——补充条单独标 sourceRef,
// 不冒充教材原文,治理方复核后才算数。新增补充条必须同时进测试的治理断言。
const CURATED_SUPPLEMENTS = [
  {
    code: "EX-HN22",
    name: "安眠",
    pinyin: "Ānmián",
    meridian: "经外奇穴",
    specialClass: undefined,
    location: "项部，翳风穴与风池穴连线的中点处。",
    indications: ["失眠，头痛，眩晕", "心悸，癫狂"],
    operation: "直刺0.8～1.2寸。",
    classicalExcerpts: undefined,
    sourceRef: "SRC-ACUPOINT-CURATED-SUPPLEMENT", // 治理补充条,非教材原文
  },
];
for (const sup of CURATED_SUPPLEMENTS) {
  if (!byCode.has(sup.code) && !entries.some((e) => e.name === sup.name)) entries.push(sup);
}

const codes = new Set(entries.map((e) => e.code));
const meridians = [...new Set(entries.map((e) => e.meridian))].filter(Boolean);
const problems = [];
// 国标 361 经穴全量校验（三焦经教材用 TE 编码）,缺一报一,不许静默通过。
const EXPECTED = [];
for (const [p, n] of [["LU", 11], ["LI", 20], ["ST", 45], ["SP", 21], ["HT", 9], ["SI", 19], ["BL", 67], ["KI", 27], ["PC", 9], ["TE", 23], ["GB", 44], ["LR", 14], ["DU", 28], ["RN", 24]]) {
  for (let i = 1; i <= n; i += 1) EXPECTED.push(`${p}${i}`);
}
const missingStd = EXPECTED.filter((c) => !codes.has(c));
if (missingStd.length) problems.push(`国标经穴缺失 ${missingStd.length}: ${missingStd.slice(0, 12).join(",")}`);
if (codes.size !== entries.length) problems.push(`代码重复: ${entries.length - codes.size} 条`);
if (meridians.length < 15) problems.push(`经脉覆盖不足(应≥15: 十二经+督任+奇穴): ${meridians.length}`);
const out = {
  schemaVersion: "tcm-acupoint-evidence-v1",
  evidenceTier: "official_standard_linked",
  governance: {
    source: "《经络腧穴学》（全国中医药行业高等教育“十三五”规划教材,中国中医药出版社）",
    extractedBy: "scripts/ingest/acupoint-evidence-extract.mjs（确定性解析,零模型调用）",
    executable: false,
    note: "穴位定位/操作仅作医师参考证据,不构成可执行指令;针刺操作须由具备资质的执业人员按机构规程实施。",
  },
  meridianCoverage: meridians,
  entries,
};
if (problems.length) {
  console.error(JSON.stringify({ problems, count: entries.length }));
  process.exit(1);
}
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
writeFileSync(REPORT, JSON.stringify({ count: entries.length, meridians, sampleNames: entries.slice(0, 5).map((e) => `${e.name}(${e.code})`), byMeridian: Object.fromEntries(meridians.map((md) => [md, entries.filter((e) => e.meridian === md).length])) }, null, 2) + "\n");
console.log(JSON.stringify({ written: OUT, count: entries.length, meridians: meridians.length }));
