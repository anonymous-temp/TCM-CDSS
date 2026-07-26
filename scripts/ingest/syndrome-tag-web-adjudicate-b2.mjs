// 第二批经典名方留空 17 首:联网核验证据补强后复审(v4-pro,同铁律+T1 归一)。
// 证据来自 2026-07-25 联网考据(局方/温疫论/伤寒论/傅青主女科/衷中参西录等通行主治与方义,
// 检索记录见 docs §11)。模型仍按主治与证据独立裁定,可勾 0–2 个,拿不准仍可留空。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DIR = resolve(ROOT, "artifacts/syndrome-tag-adjudication-b2");
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY required");

const EVIDENCE = [
  { name: "柴胡清肝汤", evidence: "《医宗金鉴》柴胡清肝治怒证(肝肾郁火),方以柴芩栀翘蒡清肝泻火、四物凉血,主治肝郁化火兼血热。", candidates: ["肝郁血热", "肝火扰心", "肝胆湿热"] },
  { name: "升麻葛根汤", evidence: "《局方》治时气温疫、头痛发热、疮疹已发未发,辛凉解肌透疹,属表热/气分热证。", candidates: ["风热犯表", "热在气分", "热炽气分"] },
  { name: "六和汤", evidence: "《局方》治夏月内伤生冷、外感暑湿之霍乱吐泻、寒热交作、胸膈痞满,祛暑化湿、健脾和胃,暑湿伤脾为本。", candidates: ["暑湿内蕴", "暑湿", "湿浊内蕴"] },
  { name: "三化汤", evidence: "《保命集》治中风入脏、邪气内实、热势极盛、二便不通,大黄枳朴羌活通腑泄热,属里实热结。", candidates: ["阳明腑实", "热炽气分", "三焦实热"] },
  { name: "升陷汤", evidence: "张锡纯《衷中参西录》治胸中大气下陷、气短不足以息、脉沉迟微弱,黄芪为君益气升陷。", candidates: ["气虚下陷", "中气下陷"] },
  { name: "香苏散", evidence: "《局方》香苏散(香附紫苏陈皮甘草)治四时感冒风寒、头痛发热恶寒、胸脘痞闷,疏风散寒兼理气。", candidates: ["风寒束表", "风寒", "气滞血瘀"] },
  { name: "枳实芍药散", evidence: "《金匮》治产后腹痛、烦满不得卧,枳实破气、芍药和血,气滞血郁腹痛为本。", candidates: ["气滞血瘀", "气血瘀滞"] },
  { name: "达原饮", evidence: "吴又可《温疫论》治瘟疫邪伏膜原:憎寒壮热、胸闷呕恶、苔白厚如积粉,开达膜原辟秽化浊,湿热秽浊为本。", candidates: ["湿热内蕴", "疫毒", "湿浊内蕴"] },
  { name: "大黄附子汤", evidence: "《金匮》治胁下偏痛发热、脉紧弦,寒实内结之腹痛,附子细辛温寒、大黄通下,温下寒积。", candidates: ["寒实", "阳虚", "寒热错杂"] },
  { name: "当归六黄汤", evidence: "《兰室秘藏》治阴虚火旺之盗汗:当归六黄加黄芪,滋阴泻火固表,阴虚火扰为本。", candidates: ["阴虚火旺", "阴虚热盛"] },
  { name: "定经汤", evidence: "《傅青主女科》治月经先后无定期,肝肾气郁,柴胡芥穗疏肝、熟地菟丝补肾,舒肝补肾养血调经。", candidates: ["肝郁肾虚", "肝肾阴虚"] },
  { name: "黄芩汤", evidence: "《伤寒论》治太阳少阳合病自下利,黄芩芍药清胆热止利,胆热下迫为本。", candidates: ["胆热", "湿热蕴结", "热炽气分"] },
  { name: "橘皮竹茹汤", evidence: "《金匮》治哕逆(呃逆),橘皮竹茹生姜人参大枣甘草,补虚清热降逆,胃虚有热为本。", candidates: ["胃气虚", "胃热", "胃气上逆"] },
  { name: "两地汤", evidence: "《傅青主女科》治月经先期量少,生地地骨皮玄参麦冬阿胶白芍,滋阴清热凉血,阴虚血热为本。", candidates: ["阴虚血热", "阴虚火旺"] },
  { name: "四妙勇安汤", evidence: "《验方新编》治脱疽(血栓闭塞性脉管炎),银花玄参当归甘草清热解毒活血,热毒炽盛为本。", candidates: ["热毒炽盛", "火热邪毒壅盛"] },
  { name: "托里消毒散", evidence: "《医宗金鉴》托里消毒散治痈疽脓成不溃或溃后正虚,参术芪归芎芍补托、银翘芷防透毒,正虚邪恋为本。", candidates: ["正虚邪恋", "气血两虚"] },
  { name: "大黄黄连泻", evidence: "即大黄黄连泻心汤,《伤寒论》治心下痞按之濡、《金匮》治心气不足吐血衄血,大黄黄连(黄芩)泻火凉血,心火亢盛血热妄行为本。", candidates: ["心火亢盛", "血热妄行", "热炽气分"] },
];

const SYS = `你是中医方证证型裁定专家。对每个方剂,依据其**主治原文与所附考据证据**裁定核心证候(0–2 个)。
铁律:
1. 只勾选对主治原文/考据证据**直接支持**的证候;证据不足 → 留空。
2. 证候必须是**主证**,不是兼治、不是或然证。
3. 优先从所给候选中选;候选外也可给国标《中医临床诊疗术语》体系内的规范名称。
4. **拿不准就留空**——留空是安全默认。
5. 输出 JSON 数组:[{"name":"方名","decision":"adopt"|"blank","tags":["证候名"],"reason":"≤30字,引用证据关键点"}]
只输出 JSON 数组。`;

const t1 = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-syndrome-lexicon.json"), "utf-8"));
const aliasToId = new Map();
const idToCanonical = new Map();
for (const e of t1.entries) {
  aliasToId.set(e.canonical, e.id);
  idToCanonical.set(e.id, e.canonical);
  for (const a of e.aliases || []) aliasToId.set(a, e.id);
}

const res = await fetch("https://api.deepseek.com/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: "deepseek-v4-pro",
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: `请复审以下 ${EVIDENCE.length} 首(主治原文见清单,考据证据附后):\n${JSON.stringify(EVIDENCE, null, 1)}` },
    ],
    temperature: 0, max_tokens: 4000, reasoning_effort: "high", thinking: { type: "enabled" }, stream: false,
  }),
});
if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
const text = (await res.json()).choices?.[0]?.message?.content || "";
const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));

const results = JSON.parse(readFileSync(resolve(DIR, "adjudicated.json"), "utf-8"));
let replaced = 0;
for (const item of arr) {
  const tags = (item.decision === "adopt" ? item.tags || [] : [])
    .map((t) => ({ name: t, id: aliasToId.get(t) || aliasToId.get(String(t).replace(/证$/, "")) || null }))
    .filter((t) => t.id);
  const idx = results.findIndex((r) => r.name === item.name);
  if (idx < 0) continue;
  if (results[idx].decision !== "blank") continue; // 只覆盖留空的
  if (!tags.length) continue; // 模型仍留空,尊重
  results[idx] = {
    ...results[idx],
    decision: "adopt",
    tags: tags.map((t) => ({ name: idToCanonical.get(t.id) || t.name, id: t.id })),
    modelTags: item.tags,
    reason: `联网纠偏复审:${item.reason || ""}`,
    webAdjudicated: true,
  };
  replaced++;
}
writeFileSync(resolve(DIR, "adjudicated.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ evidenceFormulas: EVIDENCE.length, adopted: replaced, stillBlank: EVIDENCE.length - replaced }));
