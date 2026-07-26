// GB/T 15657-2021《中医病证分类与代码》PDF 文本 → 辩病受控词表基座。
// 输入:pdftotext -layout 的 /tmp/gbt15657.txt(185 页全文本)。
// 表结构:代码行「A01.01.01.01  伤风」,紧随的无代码缩进行为正名别名(时邪感冒←时行感冒)。
// 产出:src/data/tcm-disease-lexicon.json(T1 同构治理封套;canonical+aliases+category+code+temporary)。
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = process.env.GBT15657_TXT || "/tmp/gbt15657.txt";
const OUT = resolve(ROOT, "src/data/tcm-disease-lexicon.json");

const lines = readFileSync(SRC, "utf-8").split("\n");
// 疾病部分范围:从「5.2 中医疾病名」到证候部分开始(B 码段/附录A)。
// 实测结构:表1 是类目表,疾病条目自 A01.01.01.01 伤风 始;证候条目为 B 码。
const CATEGORY_RE = /^(?:表\s*\d+\s*)?中医疾病名标识符/;
const SECTION_RE = /^5\.\d/;
const PAGE_NOISE = /^(GB\/T|\d{1,3}\s*$|\s*$)/;

const CATEGORY_OF_PREFIX = {
  A01: "外感病类", A02: "寄生虫病类", A03: "中毒与意外伤害病类", A04: "脏腑病及相关病类",
  A05: "情志病类", A06: "气血津液病类", A07: "头身形体病类", A08: "皮肤黏膜病类",
  A09: "生殖病类", A10: "小儿相关病类", A11: "眼病类", A12: "耳病类", A13: "鼻病类",
  A14: "咽喉病类", A15: "口齿病类", A16: "瘤癌病类", A17: "临时诊断用术语",
};

const entries = [];
let current = null;
let inDiseases = false;
const problems = [];
for (const rawLine of lines) {
  const line = rawLine.replace(/\s+/g, (m) => m);
  if (inDiseases && (/^B\d{2}\./.test(line.trim()) || /中医证候名标识符/.test(line) || /附录\s*A/.test(line))) break;
  const cm = line.trim().match(/^([A]\d{2}(?:\.\d{2}){1,3}\.?)\s+([一-龥（）()·、，,]{1,30})$/);
  if (cm) {
    inDiseases = true;
    current = { code: cm[1].replace(/\.$/, ""), canonical: cm[2].replace(/^'|'$/g, "").trim(), aliases: [] };
    entries.push(current);
    continue;
  }
  if (!inDiseases || !current) continue;
  const t = line.trim();
  if (!t || PAGE_NOISE.test(t) || SECTION_RE.test(t) || CATEGORY_RE.test(t)) continue;
  // 别名行:纯中文短行,非英文/定义段
  if (/^[一-龥（）()·、，,]{2,30}$/.test(t) && !/泛指|所致|病$的/.test(t)) {
    if (t !== current.canonical && !current.aliases.includes(t)) current.aliases.push(t);
  }
}

// 类目词与临时术语标注
for (const e of entries) {
  e.category = CATEGORY_OF_PREFIX[e.code.slice(0, 3)] || "未分类";
  e.temporary = e.category === "临时诊断用术语";
  e.isCategoryHeading = e.canonical.endsWith("类") && e.aliases.length === 0 && e.code.split(".").length <= 3;
}
const clinical = entries.filter((e) => !e.isCategoryHeading);
const codes = new Set(entries.map((e) => e.code));
if (codes.size !== entries.length) problems.push(`代码重复 ${entries.length - codes.size}`);
const canonCount = new Map();
for (const e of clinical) canonCount.set(e.canonical, (canonCount.get(e.canonical) || 0) + 1);
const dupNames = [...canonCount].filter(([, n]) => n > 1).map(([k]) => k);
if (dupNames.length) problems.push(`正名重复(可能为同名异类,保留但需复核): ${dupNames.slice(0, 10).join("、")}`);


// ─── 临床扩展层(规划教材/高频临床叫法,受控增补) ───
// 两类:ALIAS_EXTENSIONS 输入名→标准正名的映射(目标必须已存在于标准词表,构建期校验);
// CANONICAL_EXTENSIONS GB 未收但教材级通用的病名(痞满已能映射到胃痞病,不在此列)。
// 每条都带来源与理由;拿不准(歧义/多指)一律不收——例:脚气(湿脚气 vs 维生素B1缺乏脚气病)。
const ALIAS_EXTENSIONS = [
  // 高频主诉口语→标准正名(覆盖既有 9 条手工规则并扩面)
  ["失眠", "不寐病", "规划教材《中医内科学》不寐=失眠"], ["失眠症", "不寐病", "现代医案高频用名"],
  ["头晕", "眩晕", "教材通用"], ["头昏", "眩晕", "口语"], ["心慌", "心悸", "口语"],
  ["胃疼", "胃痛", "口语,胃痛为标准正名"], ["腹泻", "泄泻病", "口语"], ["拉肚子", "泄泻病", "口语"],
  // 皮外骨伤
  ["湿疹", "湿疮", "教材对应"], ["荨麻疹", "瘾疹", "教材对应"], ["银屑病", "白疕", "教材对应"],
  ["牛皮癣", "白疕", "俗称"], ["神经性皮炎", "摄领疮", "教材对应"],
  ["带状疱疹", "蛇串疮", "教材对应"], ["蛇盘疮", "蛇串疮", "俗名"], ["缠腰火丹", "蛇串疮", "俗名"],
  ["黄褐斑", "黧黑斑", "标准收载正形"], ["肝斑", "黧黑斑", "俗称"],
  ["斑秃", "油风", "教材对应"], ["鬼剃头", "油风", "俗名"],
  ["香港脚", "脚湿气", "俗称"], ["花斑癣", "紫白癜风", "教材对应"], ["汗斑", "紫白癜风", "俗称"],
  ["股癣", "阴癣", "教材对应"], ["白癜风", "白驳风", "教材对应"],
  ["痤疮", "粉刺", "教材对应"], ["青春痘", "粉刺", "俗称"],
  // 五官
  ["面瘫", "口僻", "教材对应"], ["吊线风", "口僻", "俗名"], ["口眼歪斜", "口僻", "症状描述"],
  ["麦粒肿", "针眼", "教材对应"], ["霰粒肿", "胞生痰核", "教材对应"], ["老花眼", "老视", "教材对应"],
  ["白内障", "圆翳内障", "教材对应"], ["翼状胬肉", "胬肉攀睛", "教材对应"],
  ["飞蚊症", "云雾移睛", "教材对应"], ["沙眼", "椒疮", "教材对应"],
  ["鼻窦炎", "鼻渊", "中西医对应(医案高频)"], ["扁桃体炎", "乳蛾", "教材对应"],
  ["咽喉炎", "喉痹", "教材对应"], ["喉喑", "失音", "教材正名为失音"], ["声音嘶哑", "失音", "症状描述"],
  ["口腔溃疡", "口糜", "教材对应(口糜=口疮)"], ["雪口", "鹅口疮", "俗名"], ["牙龈炎", "牙宣", "教材对应"],
  // 妇儿
  ["妊娠恶阻", "恶阻", "教材对应"], ["先兆流产", "胎动不安", "中西医对应(医案高频)"],
  ["习惯性流产", "滑胎", "教材对应"], ["月经稀发", "月经后期", "教材对应"],
  ["继发性不孕症", "不孕", "医案高频"],
  ["继发不孕", "不孕", "医案高频"], ["原发不孕", "不孕", "医案高频"], ["不孕症", "不孕", "医案高频"],
  ["多动症", "小儿多动症", "通用简称"],
  // 医案高频别名与中西医对应(2026-07-26 语料实测)
  ["痹症", "痹证类病", "医案高频(×96),痹之俗称"], ["痫证", "痫病", "俗称"], ["癫痫", "痫病", "中西医对应"],
  ["痞证", "胃痞病", "俗称"], ["瘿病", "瘿类病", "教材对应"],
  ["抑郁症", "郁病", "中西医对应(教材)"], ["神经官能症", "郁病", "中西医对应"],
  ["植物神经功能紊乱", "郁病", "中西医对应"], ["神经衰弱", "不寐病", "主症失眠时对应"],
  ["功能失调性子宫出血", "崩漏", "中西医对应(医案高频)"], ["功能性子宫出血", "崩漏", "中西医对应"],
  ["漏下", "崩漏", "崩漏之别称"], ["多动证", "小儿多动症", "医案写法"],
  ["血管神经性头痛", "头痛", "中西医对应(泛型)"], ["血管性头痛", "头痛", "中西医对应(泛型)"],
  ["周围性面神经麻痹", "口僻", "中西医对应"], ["心律失常", "心悸", "中西医对应(泛型)"], ["神经性头痛", "头痛", "中西医对应(泛型)"], ["原发性不孕症", "不孕", "医案写法"],
 ["功血", "崩漏", "功能性子宫出血的临床缩写"], ["血尿", "尿血", "通用语"], ["神经症", "郁病", "中西医对应"],
 ["心刺痛", "胸痹心痛", "症译"], ["结节性红斑", "瓜藤缠", "中西医对应(教材)"],
 ["脑供血不足", "眩晕", "中西医对应(临床惯例)"], ["椎基底动脉供血不足", "眩晕", "中西医对应(临床惯例)"],
 ["精神分裂症", "癫病", "中西医对应(癫狂类,取癫病)"], ["三叉神经痛", "面风痛", "中西医对应"],
 ["焦虑症", "郁病", "中西医对应"], ["肠蕈", "肠覃", "异体字(蕈=覃)"],
 ["膈肌痉挛", "呃逆病", "中西医对应"], ["扁平疣", "扁瘊", "中西医对应"], ["神经性耳鸣", "耳鸣", "中西医对应"],
 ["心激荡", "心悸", "异文"], ["积证", "积聚", "俗称"], ["经行头痛", "头痛", "归经行诸证之属,按头痛归一"],
 ["面神经麻痹", "口僻", "中西医对应"], ["经断前后诸证", "绝经前后诸症", "异写(证/症)"],
 ["女性不育症", "不孕", "医案写法"], ["不育症", "不孕", "医案写法"],
 ["椎动脉型颈椎病", "项痹", "中西医对应"], ["性功能减退", "房事阳痿", "中西医对应(泛型)"], ["阳痿", "房事阳痿", "标准正形为房事阳痿"], ["早泄", "房事早泄", "标准正形为房事早泄"],
 ["青光眼", "青风内障", "中西医对应(教材,青风为主型)"],
 ["失调性子宫出血", "崩漏", "同功血异写"], ["多汗", "汗证", "口语"], ["咳喘", "喘病", "口语合称"],
 ["心脏神经官能症", "心悸", "中西医对应"], ["心绞痛", "胸痹心痛", "中西医对应"], ["内外痔", "混合痔", "临床合称"],
 ["癔病", "脏躁", "中西医对应(脏躁=癔病)"], ["肩凝", "漏肩风", "教材对应(肩周炎)"],
 ["神经性耳聋", "耳聋", "中西医对应"], ["抽动症", "慢惊风", "中西医对应(儿科,取近义)"], ["肠易激综合症", "肠郁", "中西医对应(教材)"],
 ["足跟痛", "跟痛症", "俗称"], ["肾劳", "虚劳类病", "俗称"], ["痞", "胃痞病", "单字俗称"], ["久痢", "痢疾", "俗称"], ["脘腹痛", "胃痛", "俗称"], ["疫毒", "疫病", "俗称"], ["上感", "感冒", "临床缩写"], ["痒疹", "风瘙痒", "教材对应"],
 ["扭挫伤", "筋伤", "统称"], ["绝经前后诸证", "绝经前后诸症", "异写(证/症)"],
 ["腰部扭挫伤", "腰痛", "俗称"], ["赫依性晕厥", "眩晕", "医案写法"], ["鼻出血", "鼻衄", "通用语"],
 ["消化功能紊乱", "胃痞病", "中西医对应"], ["植物神经功能失调", "郁病", "异写(失调/紊乱)"],
 ["颈椎退行性变", "项痹", "中西医对应"],
 ["梅核丹", "梅核气", "OCR 异文"], ["神经官能证", "郁病", "异写(证/症)"], ["急喉瘖", "喉瘖", "教材对应(急喉瘖)"],
 ["泌感", "淋证", "临床缩写(泌尿系感染)"], ["萎证", "痿证类病", "形近误写(痿证类病之别名痿病)"], ["室性过早搏动", "心悸", "中西医对应"],
 ["精神分裂证", "癫病", "异写(证/症)"], ["心下痞", "胃痞病", "俗称"], ["腰椎管狭窄症", "腰痛", "中西医对应(泛型)"],
 ["脑性瘫痪", "五迟", "中西医对应(儿科,取五迟五软之五迟)"], ["双眼近觑", "近视", "古称(近觑=近视)"],
 ["外伤性内收肌损伤", "筋伤", "统称"], ["精液不液化", "精浊", "中西医对应"],
 ["月经后错", "月经后期", "俗称"], ["前列腺肥大", "精癃", "中西医对应"], ["瘿瘤", "瘿类病", "俗称"],
 ["双眼白涩症", "白涩症", "医案写法"], ["干眼症", "白涩症", "中西医对应"],
 ["局限性硬皮病", "皮痹", "中西医对应"], ["隐疹", "瘾疹", "异写"], ["经脉痹", "痹证类病", "俗称"], ["消化不良", "胃痞病", "中西医对应(成人泛型)"],
  ["颤证", "颤病", "俗称"], ["继发性闭经", "闭经", "医案写法"], ["更年期综合症", "绝经前后诸症", "中西医对应"], ["经断前后诸症", "绝经前后诸症", "异写"],
 ["肛周脓肿", "肛痈", "中西医对应"], ["月经量少", "月经过少", "俗称"], ["胃肠功能紊乱", "胃痞病", "中西医对应"],
 ["胃下垂", "胃缓", "中西医对应(教材)"], ["股骨头缺血性坏死", "骨蚀", "中西医对应"], ["妇人腹痛", "腹痛", "妇科语境同腹痛"],
  ["不育", "不孕", "男女通用语与女科正名归一"],
  // 内科其他
  ["霍乱", "疫霍乱", "标准正形为疫霍乱"], ["痞满", "胃痞病", "教材通用,标准正形胃痞病"],
  ["中风-中经络", "中风病", "医案分型写法"], ["血虚劳", "虚劳类病", "医案用名"],
  ["肿胀", "水肿", "口语"], ["口噼", "口僻", "OCR 异文"],
];
const CANONICAL_EXTENSIONS = [
  ["月经不调", ["月经失调", "月经先期", "月经后期", "月经先后无定期"], "教材通用总称,GB/T 15657 未单列"],
  ["血证", [], "《中医内科学》病名,泛指各部位出血"],
  ["汗证", ["自汗", "盗汗"], "教材病名,GB 未单列"],
  ["积聚", ["癥瘕"], "教材病名(积=癥,聚=瘕)"],
  ["奔豚气", [], "教材病名(气从少腹上冲)"],
  ["嗳气", [], "教材病名"], ["吞酸", [], "教材病名"],
  ["五更泄", ["鸡鸣泄", "肾泄"], "教材病名(五更泻)"],
  ["缺乳", [], "教材病名(产后乳汁不足)"],
  ["尿频", [], "教材病名"],
  ["消渴目病", ["双眼消渴目病"], "《中医眼科学》病名(糖尿病视网膜病变),医案高频"],
  ["颈痛", [], "教材/临床通用病名(GB 未单列)"],
  ["腰腿痛", [], "教材/临床通用病名(GB 未单列)"],
  ["纳呆", [], "症状层工作病名(食少纳呆,提示词允许的症状层命名)"],
  ["皮疹", [], "症状层工作病名(GB 未单列)"],
  ["斑疹", [], "症状层工作病名(GB 未单列)"],
  ["项痹", ["颈椎病", "神经根型颈椎病", "椎动脉型颈椎病"], "《中医骨伤科学》病名(GB 未单列)"],
  ["青风内障", ["青光眼"], "《中医眼科学》病名(GB 未单列)"],
  ["绿风内障", [], "《中医眼科学》病名(GB 未单列)"],
  ["暑湿", [], "温病类病名(GB 未单列,与暑温病互参)"],
  ["跟痛症", [], "临床通用病名(GB 未单列)"],
  ["筋伤", [], "伤科通用病名(GB 未单列)"],
  ["溺毒", [], "《中医内科学》病名(尿毒症),GB 未单列"],
  ["亚健康", [], "现代通用状态名(GB 未单列)"],
  ["腰酸", [], "症状层工作病名(GB 未单列)"],
  ["落枕", [], "临床通用病名(GB 未单列)"],
  ["瘈疭", [], "古籍病名(手足抽搐),GB 未单列"],
  ["经行情志异常", [], "教材/临床通用病名(周期性情绪障碍),GB 未单列"],
];
const canonicalNames = new Set();
const canonicalByName = new Map();
for (const e of entries) { canonicalNames.add(e.canonical); canonicalByName.set(e.canonical, e); }
for (const [canon, aliases] of CANONICAL_EXTENSIONS) {
  if (canonicalByName.has(canon)) { aliasProblems.push(`扩展正名与标准冲突:${canon}`); continue; }
  entries.push({
    code: `EXT-${canon}`,
    canonical: canon,
    aliases: aliases.filter((a) => !canonicalByName.has(a)),
    category: "临床扩展",
    temporary: false,
    isCategoryHeading: false,
  });
  canonicalNames.add(canon);
  canonicalByName.set(canon, entries[entries.length - 1]);
}
const extAliasRows = [];
const aliasProblems = [];
for (const [input, target, note] of ALIAS_EXTENSIONS) {
  if (!canonicalByName.has(target)) { aliasProblems.push(`扩展别名目标不在标准词表:${input}→${target}`); continue; }
  canonicalByName.get(target).aliases.push(input);
  extAliasRows.push([input, target, note]);
}
if (aliasProblems.length) {
  console.error(JSON.stringify({ aliasProblems }));
  process.exit(1);
}

// 长尾裁定合并(disease-name-tail-adjudication 产物):v4-pro 裁定+目标在表校验通过的
// 扩展别名,作为可复现输入并入词表——直接改 JSON 会在重建时被覆盖(2026-07-26 实测教训)。
const TAIL_ADJ_PATH = resolve(ROOT, "artifacts/disease-name-tail-adjudication/adjudicated.json");
try {
  const tailAdj = JSON.parse(readFileSync(TAIL_ADJ_PATH, "utf-8"));
  const byCanon = new Map(entries.map((e) => [e.canonical, e]));
  const aliasOwner = new Map();
  for (const e of entries) for (const a of e.aliases) if (!aliasOwner.has(a)) aliasOwner.set(a, e);
  let tailMerged = 0;
  for (const o of tailAdj) {
    if (!(o && o.ok && o.to && !o.hold)) continue;
    const target = byCanon.get(o.to) || aliasOwner.get(o.to);
    if (!target) continue;
    const name = String(o.name || "").trim();
    if (!name || name === target.canonical || target.aliases.includes(name)) continue;
    target.aliases.push(name);
    if (!aliasOwner.has(name)) aliasOwner.set(name, target);
    tailMerged++;
  }
  console.log(JSON.stringify({ tailAdjudicationMerged: tailMerged }));
} catch {
  console.log(JSON.stringify({ tailAdjudicationMerged: 0, note: "无长尾裁定产物,跳过" }));
}

// 别名撞名裁决:同一别名挂在两个正名下时,类目词(…类病/…类)输给具体正名;
// 仍分不出的进 ambiguousAliases,从别名表剔除——同名异物不许自动映射(如 牛皮癣 古义=摄领疮(神经性皮炎)、
// 今义=白疕(银屑病);喉喑 两属喉瘖/失音)。解析层对这些输入按 unverified 处理,不猜。
{
  const owner = new Map();
  for (const e of entries) for (const a of e.aliases) {
    if (!owner.has(a)) owner.set(a, new Set());
    owner.get(a).add(e);
  }
  const ambiguous = [];
  for (const [alias, owners] of owner) {
    if (owners.size < 2) continue;
    const specific = [...owners].filter((e) => !/类(?:病)?$/.test(e.canonical));
    if (specific.length === 1) {
      for (const e of owners) if (e !== specific[0]) e.aliases = e.aliases.filter((x) => x !== alias);
    } else {
      ambiguous.push({ alias, candidates: [...owners].map((e) => e.canonical) });
      for (const e of owners) e.aliases = e.aliases.filter((x) => x !== alias);
    }
  }
  if (ambiguous.length) console.log(JSON.stringify({ ambiguousAliases: ambiguous }));
  globalThis.__AMBIGUOUS_ALIASES = ambiguous;
}


const sha2 = (v) => createHash("sha256").update(v).digest("hex").slice(0, 16).toUpperCase();
const out = {
  schemaVersion: "tcm-disease-lexicon-v1",
  sourceRefs: ["SRC-GBT-15657-2021", "SRC-TEXTBOOK-CLINICAL-EXTENSION"],
  note: "辩病受控词表。基座=GB/T 15657-2021《中医病证分类与代码》疾病部分(沿用 GB/T 16751.1-2023 疾病术语,1,369 名含类目词与 53 临时诊断用术语,文本实得 1,239 个编码条目,余为类目层级节点);别名=标准正名同义语+临床扩展别名(教材/高频口语,逐条带依据,歧义不收)。临时诊断用术语不得用于门诊和出入院诊断(标 temporary)。",
  summary: {
    totalEntries: entries.length,
    clinicalEntries: entries.filter((e) => !e.isCategoryHeading).length,
    categoryHeadings: entries.filter((e) => e.isCategoryHeading).length,
    temporaryTerms: entries.filter((e) => e.temporary).length,
    aliasCount: entries.reduce((n, e) => n + e.aliases.length, 0),
    clinicalExtensionAliases: extAliasRows.length,
    clinicalExtensionCanonicals: CANONICAL_EXTENSIONS.length,
  },
  ambiguousAliases: globalThis.__AMBIGUOUS_ALIASES || [],
  entries: entries.map((e) => ({
    id: `TCM-DISEASE-${sha2(e.code + e.canonical)}`,
    code: e.code,
    canonical: e.canonical,
    aliases: e.aliases,
    category: e.category,
    temporary: e.temporary,
    isCategoryHeading: e.isCategoryHeading,
    sourceRefs: e.category === "临床扩展" ? ["SRC-TEXTBOOK-CLINICAL-EXTENSION"] : ["SRC-GBT-15657-2021"],
  })),
};
console.log(JSON.stringify({ ...out.summary, problems }));
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
