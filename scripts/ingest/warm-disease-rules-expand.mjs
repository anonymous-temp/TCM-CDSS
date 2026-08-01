// Batch A：温病辨证规则全量扩展。
// 通道：tcmoc 温病 18 书条文 → v4-pro 按既有 14 条的 schema 草拟 → 确定性校验
// （方名⊆T8 目录、triggerTerms 3-8、groundingExcerpt 可回溯原文、与既有规则去重）
// → artifacts/warm-disease-rules-expansion/new-rules.json。
// 铁律：每条规则必须有真实条文锚（滑窗反查 tcmoc 原文），凭记忆写的一律拒收。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callAdjudicator, runPool, readCheckpoint } from "./deepseek-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DATA = resolve(ROOT, "src/data");
const OUT = resolve(ROOT, "artifacts/warm-disease-rules-expansion");
mkdirSync(OUT, { recursive: true });
const ONLY_THEME = process.env.ONLY_THEME || "";
const MAX_THEMES = Number(process.env.MAX_THEMES || 99);

const source = JSON.parse(readFileSync(resolve(DATA, "tcm-warm-disease-rules.source.json"), "utf-8"));
const catalog = JSON.parse(readFileSync(resolve(DATA, "tcm-formula-governed-catalog.json"), "utf-8"));
const catalogNames = new Set(catalog.entries.map((e) => e.name));

const WARM_BOOKS = ["温病条辨", "温热经纬", "重订广温热论", "松峰说疫", "温病正宗", "时病论",
  "疫疹一得", "广瘟疫论", "温疫论", "温热逢源", "痧胀玉衡", "温热暑疫全书", "增订叶评伤暑全书",
  "温病指南", "温热论", "专治麻痧初编", "痧疹辑要"];
const warmParas = [];
{
  const lines = readFileSync(resolve(DATA, "tcm-classic-text-evidence-tcmoc.jsonl"), "utf-8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!WARM_BOOKS.includes(row.book)) continue;
    warmParas.push({ book: row.book, chapter: row.chapter || "", text: String(row.text || "") });
  }
}
console.log(JSON.stringify({ warmParagraphs: warmParas.length, existingRules: source.rules.length }));

const normalize = (value) => String(value || "")
  .replace(/[\s，。；：、,.!?！？“”‘’「」『』（）()\[\]〔〕…·#\-]/g, "");
const warmCorpus = normalize(warmParas.map((p) => p.text).join(""));

const THEMES = [
  { id: "wei-variants", title: "卫分变体鉴别（风温/冬温/秋燥犯卫/暑温初起/湿温初起之间的分界）", keywords: ["卫分", "恶风", "微恶寒", "咽痛", "咳嗽", "头痛", "脉浮"], count: 6 },
  { id: "qi-yangming", title: "气分·阳明经热与腑实的分界（白虎类与承气类）", keywords: ["白虎", "承气", "大渴", "汗大出", "脉洪", "潮热", "便秘", "谵语"], count: 6 },
  { id: "qi-lung-chest", title: "气分·热壅于肺与热郁胸膈（麻杏石甘/栀子豉/凉膈类）", keywords: ["喘", "胸膈", "烦热", "麻杏", "栀子豉", "凉膈"], count: 5 },
  { id: "qi-damp-heat", title: "气分·湿热与暑湿（三仁汤/甘露消毒丹/王氏清暑益气汤/新加香薷饮/清络饮）", keywords: ["暑", "湿", "三仁", "甘露消毒", "清暑益气", "香薷", "身热不扬"], count: 6 },
  { id: "ying-level", title: "营分（热入营分/营热阴伤/逆传心包/清宫汤/清营汤）", keywords: ["营分", "清营", "清宫", "舌绛", "心烦", "谵语", "斑疹隐隐"], count: 5 },
  { id: "blood-level", title: "血分（动血/耗血/瘀热互结/犀角地黄汤/化斑汤）", keywords: ["血分", "动血", "吐衄", "便血", "发斑", "犀角地黄", "化斑"], count: 5 },
  { id: "wind", title: "动风（热极生风与阴虚风动/羚羊钩藤/大小定风珠/三甲复脉）", keywords: ["动风", "痉", "抽搐", "角弓", "定风珠", "复脉", "羚羊", "钩藤", "心中大动"], count: 6 },
  { id: "damp-warm-principles", title: "湿温总纲与治疗禁忌（湿温三禁：忌汗/忌下/忌润）", keywords: ["湿温", "三禁", "忌汗", "忌下", "忌润", "恶寒", "身重", "苔白腻"], count: 5 },
  { id: "damp-predominance", title: "湿温·湿重于热与热重于湿（藿朴夏苓/三仁/甘露消毒/白虎加苍术）", keywords: ["湿重于热", "热重于湿", "藿朴夏苓", "白腻", "黄腻", "滑石", "苍术"], count: 5 },
  { id: "sanjiao-upper", title: "三焦·上焦（肺卫与心包/邪陷心包的开窍法）", keywords: ["上焦", "肺", "心包", "神昏", "安宫", "紫雪", "至宝", "菖蒲郁金"], count: 5 },
  { id: "sanjiao-middle", title: "三焦·中焦（阳明温病与太阴湿温的分野）", keywords: ["中焦", "阳明", "太阴", "脘痞", "呕恶", "便溏", "腹满"], count: 5 },
  { id: "sanjiao-lower", title: "三焦·下焦（肝肾阴伤/加减复脉/黄连阿胶/青蒿鳖甲/邪少虚多）", keywords: ["下焦", "肝肾", "阴伤", "复脉", "黄连阿胶", "青蒿鳖甲", "舌绛", "脉细数"], count: 6 },
  { id: "fushu", title: "伏暑与晚发（伏暑发于秋冬/暑湿伏气与新感引动）", keywords: ["伏暑", "晚发", "伏气", "秋冬", "暑湿"], count: 4 },
  { id: "qiuzao", title: "秋燥（温燥与凉燥/燥伤肺胃/桑杏汤/清燥救肺汤/沙参麦冬汤）", keywords: ["燥", "秋燥", "温燥", "凉燥", "桑杏", "清燥救肺", "沙参麦冬", "干咳"], count: 5 },
  { id: "epidemic-toxin", title: "疫毒（大头瘟/烂喉痧/疫疹/清瘟败毒饮/普济消毒饮/升降散/达原饮膜原诸变）", keywords: ["疫", "大头瘟", "烂喉", "痧", "清瘟败毒", "普济消毒", "升降散", "达原饮", "膜原"], count: 6 },
  { id: "convalescence", title: "温病善后与禁忌（益胃汤/增液汤/余热未清/食复劳复/瘥后调理）", keywords: ["善后", "益胃", "增液", "余热", "食复", "劳复", "瘥后", "调理"], count: 5 },
];

const SYS = `你是温病学辨证规则编纂专家，为临床决策支持系统编写「鉴别规则」。每条规则回答一个能改变选方方向的鉴别问题。
输出 JSON 数组，每个元素严格为：
{"id":"T13-WQXX-<大写英文slug>","priority":60-100整数,"informationGain":0-1,"triggerTerms":["3-8个患者可出现的症状/舌脉原文词"],"question":"一个具体的鉴别问题（≥12字，说明问什么、区分什么）","resolves":["2-4首方名"],"discriminates":["同resolves"],"dimensions":["如 卫气营血/三焦/寒热/虚实/津液/湿热"],"sourceRefs":["《书》·篇#条文起句"],"groundingExcerpt":"支撑本条的多段条文原文拼接（≥30字，用／分隔）"}
铁律：
1. 每个 triggerTerm 必须能在所附条文原文中找到依据，且是患者层面可观察的表现，不得用书目篇名当触发词。
2. resolves/discriminates 的方名**必须出自所附受控方名清单**——清单外的方（即使真实存在）一律不用。
3. 每条规则必须能用一个 8 字以上的 groundingExcerpt 连续片段在所附原文中定位；编不出处的一律不写。
4. 不得与所附既有规则重复（同一鉴别问题不重复占格）。
5. 宁缺毋滥：条文支撑不足的主题少写或不写。只输出 JSON 数组。`;

const relevantCatalogNames = [...catalogNames].filter((name) =>
  /(?:汤|饮|散|丸|丹|膏|汁)$/.test(name) && catalog.entries.some((e) =>
    e.name === name && /(?:温|热|暑|湿|燥|疫|营|血|阴|风|痧|毒|清|宣|透|凉|生津|养阴)/.test(`${e.name}${(e.indications || "").slice(0, 120)}`)));

const existingDigest = source.rules.map((r) => `${r.id}｜问：${r.question.slice(0, 40)}｜方：${r.resolves.join("/")}`);

async function handleTheme(theme) {
  const scored = warmParas
    .map((p) => {
      const hits = theme.keywords.filter((k) => p.text.includes(k));
      return { ...p, score: hits.length };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 28);
  const excerpts = scored.map((p) => `《${p.book}》${p.chapter ? `·${p.chapter}` : ""}：${p.text.slice(0, 220)}`);
  const user = [
    `主题：${theme.title}`,
    `请编写 ${theme.count} 条鉴别规则（条文支撑不足时可少写）。`,
    `\n【条文原文（来源已标注，groundingExcerpt 必须出自这里）】\n${excerpts.join("\n")}`,
    `\n【受控方名清单（resolves 只能从这里选）】\n${relevantCatalogNames.join("、")}`,
    `\n【既有规则（不得重复）】\n${existingDigest.join("\n")}`,
  ].join("\n");
  const draft = await callAdjudicator({ system: SYS, user, maxTokens: 12000 });
  return { theme: theme.id, draft };
}

function validateRule(rule, seenIds, seenQuestions) {
  const problems = [];
  if (!/^T13-WQXX-[A-Z0-9][A-Z0-9-]{3,}$/.test(rule.id || "")) problems.push("id 非法");
  if (seenIds.has(rule.id)) problems.push("id 重复");
  if (!Number.isInteger(rule.priority) || rule.priority < 60 || rule.priority > 100) problems.push("priority 越界");
  if (!(rule.informationGain > 0 && rule.informationGain <= 1)) problems.push("informationGain 越界");
  const terms = Array.isArray(rule.triggerTerms) ? rule.triggerTerms.filter((t) => typeof t === "string" && t.trim()) : [];
  if (terms.length < 3 || terms.length > 8) problems.push(`triggerTerms 数=${terms.length}`);
  if (terms.some((t) => t.length < 2 || t.length > 10)) problems.push("triggerTerm 长度异常");
  if (!rule.question || String(rule.question).length < 12) problems.push("question 过短");
  const resolves = (rule.resolves || []).filter((n) => catalogNames.has(n));
  const dropped = (rule.resolves || []).filter((n) => !catalogNames.has(n));
  if (dropped.length) problems.push(`目录外方名已剔除:${dropped.join("/")}`);
  if (resolves.length < 2) problems.push("受控方不足 2 首");
  if (!Array.isArray(rule.dimensions) || rule.dimensions.length === 0) problems.push("dimensions 空");
  if (!Array.isArray(rule.sourceRefs) || rule.sourceRefs.length === 0) problems.push("sourceRefs 空");
  if (!rule.groundingExcerpt || String(rule.groundingExcerpt).length < 30) problems.push("groundingExcerpt 过短");
  // 原文可回溯：groundingExcerpt 的滑窗片段至少一个真实存在于温病语料
  const anchor = normalize(rule.groundingExcerpt);
  let grounded = false;
  for (let i = 0; i + 12 <= anchor.length && !grounded; i += 4) {
    if (warmCorpus.includes(anchor.slice(i, i + 12))) grounded = true;
  }
  if (!grounded) problems.push("groundingExcerpt 无法在原文定位（拒收）");
  // sourceRef 锚反查
  for (const ref of rule.sourceRefs || []) {
    const refAnchor = normalize(String(ref).split("#").slice(1).join("#")).replace(/^[〇零一二三四五六七八九十百]+/, "");
    if (refAnchor.length < 8) continue;
    let ok = false;
    for (let i = 0; i + 8 <= refAnchor.length && !ok; i += 4) {
      if (warmCorpus.includes(refAnchor.slice(i, i + 12))) ok = true;
    }
    if (!ok) problems.push(`sourceRef 锚不可回溯:${String(ref).slice(0, 40)}`);
  }
  // 去重：问题相似（字符二元组 Jaccard）
  const bigrams = new Set();
  const q = normalize(rule.question);
  for (let i = 0; i + 2 <= q.length; i += 1) bigrams.add(q.slice(i, i + 2));
  for (const prev of seenQuestions) {
    let inter = 0;
    for (const b of bigrams) if (prev.has(b)) inter += 1;
    if (inter / (bigrams.size + prev.size - inter) > 0.55) { problems.push("与既有规则同题（去重拒收）"); break; }
  }
  return { problems, resolves, dropped };
}

const themes = THEMES.filter((t) => !ONLY_THEME || t.id === ONLY_THEME).slice(0, MAX_THEMES);
await runPool({
  items: themes,
  keyOf: (t) => t.id,
  workers: 3,
  checkpointPath: resolve(OUT, "checkpoint.jsonl"),
  handle: handleTheme,
});

// 汇总校验
const cp = readCheckpoint(resolve(OUT, "checkpoint.jsonl"));
const seenIds = new Set(source.rules.map((r) => r.id));
const seenQuestions = source.rules.map((r) => {
  const s = new Set();
  const q = normalize(r.question);
  for (let i = 0; i + 2 <= q.length; i += 1) s.add(q.slice(i, i + 2));
  return s;
});
const accepted = [];
const rejected = [];
for (const [themeId, record] of cp) {
  if (!record.ok) { rejected.push({ themeId, problems: [record.error] }); continue; }
  for (const raw of record.result.draft || []) {
    const { problems, resolves } = validateRule(raw, seenIds, seenQuestions);
    const hard = problems.filter((p) => !p.startsWith("目录外方名已剔除"));
    if (hard.length === 0) {
      const rule = { ...raw, resolves, discriminates: (raw.discriminates || []).filter((n) => catalogNames.has(n)) };
      if (rule.discriminates.length === 0) rule.discriminates = resolves;
      accepted.push(rule);
      seenIds.add(rule.id);
      const s = new Set();
      const q = normalize(rule.question);
      for (let i = 0; i + 2 <= q.length; i += 1) s.add(q.slice(i, i + 2));
      seenQuestions.push(s);
    } else {
      rejected.push({ themeId, id: raw.id, problems });
    }
  }
}
writeFileSync(resolve(OUT, "new-rules.json"), JSON.stringify(accepted, null, 2) + "\n");
writeFileSync(resolve(OUT, "rejected.json"), JSON.stringify(rejected, null, 2) + "\n");
console.log(JSON.stringify({ accepted: accepted.length, rejected: rejected.length, themes: themes.length }));
