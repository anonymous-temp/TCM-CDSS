// 缺字修复应用器:pass1 LLM + 物料归一 + pass2 LLM + 人工裁定增补 → 写入 supplements。
// DROP 纪律:联网核验不过的 canonical 修复一律弃用(白膏黄/痞气丸桂/大苦参丸生/神秘散鸡),
// 保持缺字数据缺陷标记,fail-closed 不进剂量编制——拿不准不猜。
// 用法: node scripts/ingest/corrupt-herb-repair-apply.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SUPP = resolve(ROOT, "src/data/tcm-verified-formula-supplements.json");
const DIR = resolve(ROOT, "artifacts/corrupt-herb-repair");

const DROP = new Set([
  "白膏|黄", "痞气丸|桂", "大苦参丸|生", "神秘散|鸡", // 联网核验不过,fail-closed 弃用
]);
// 人工裁定增补(回源段原文/通行组成/物料归一,依据见各 evidence 注释)
const CURATED = [
  ["延龄丹", "本", "藁本", "canonical:《三因极一病证方论》同方完整组成及历代通行药名"],
  ["真应散", "枣", "大枣", "text:《三因极一病证方论》原文明确为「枣子一个」"],
  ["碧雪丹", "西", "西黄", "text:《古方汇精》原文行断裂为「西\\n（四分）」,同方组成校本为西黄"],
  ["治服石虚热水肿方", "巴", "巴豆", "text:《外台秘要》同源葱豆洗汤原文明确为「巴豆一百枚」"],
  ["东垣胃风汤", "本", "藁本", "canonical:东垣胃风汤通行组成含藁本,源段「羌活五分 本五分」序列自洽"],
  ["大黄虫丸", "虫", "䗪虫", "canonical:大黄䗪虫丸(《金匮》)组成,源段虻虫/蛴螬已见"],
  ["五灰散", "皮", "刺猬皮", "canonical:五灰散(《三因》)鳖甲/猬皮/悬蹄甲/蜂房/蛇蜕"],
  ["旋复花汤", "葱", "葱白", "text:源段「葱十四茎」"],
  ["妊娠随月养胎及服药方", "麦", "大麦", "text:源段「宜食大麦」"],
  ["替针丸", "砂", "硇砂", "canonical:替针丸(外科)雄雀粪/硇砂/陈仓米/没药"],
  ["木香枳壳丸", "牛", "牵牛子", "canonical:木香枳壳丸升降滞气,牵牛子导滞"],
  ["治虚烦不眠及汗出不止方", "萆", "萆薢", "canonical:千里流水汤(《千金》)组成含萆薢"],
  ["治伤寒后下利脓血及发斑方", "豉", "淡豆豉", "canonical:篇内栀子豉汤语境"],
  ["治伤寒后呕恶不食虚羸方", "生", "生姜", "canonical:《千金》竹叶石膏汤变体含生姜"],
  ["治天行诸病方", "饧", "饴糖", "text:源段「以饧半斤」"],
  ["治天行诸病方", "蜜", "蜂蜜", "substance"],
  ["治妇人阴脱及阴疮、阴痒方", "皮", "刺猬皮", "canonical:阴下脱散方(《外台》)当归/黄芩/牡蛎/芍药/猬皮"],
  ["龙脑鸡苏丸", "黄", "黄芪", "canonical:龙脑鸡苏丸(《局方》)组成含黄芪"],
  ["砂丸", "砂", "硇砂", "text:源段「咸热…性有毒…软坚消积」为硇砂性味"],
  ["柴胡加桂汤", "桂", "桂枝", "canonical:柴胡加桂汤即柴胡汤加桂枝"],
  ["枳实消痞丸", "白", "白术", "canonical:枳实消痞丸组成含白术"],
  ["局方神术散", "本", "藁本", "canonical:神术散(《局方》)苍术/藁本/白芷/细辛/羌活/川芎/甘草"],
  ["治诸虫方", "芦", "芦荟", "canonical:打虫语境"],
  ["治诸虫方", "雷", "雷丸", "canonical:打虫语境,雷丸专药"],
  ["顺气消食化痰丸", "山", "山楂", "canonical:消食语境"],
  ["治卒魇方", "薤", "薤白", "canonical:肘后卒魇方语境"],
  ["治卒魇方", "韭", "韭白", "canonical:同上"],
  ["治卒魇方", "盐", "食盐", "substance"],
  ["回生丹", "珀", "琥珀", "canonical:回生丹组成含琥珀"],
  ["杏仁煎", "蜜", "蜂蜜", "substance"],
  ["枸杞酒", "酒", "黄酒", "substance"], ["猪膏酒", "酒", "黄酒", "substance"],
  ["银苎酒", "酒", "黄酒", "substance"], ["莨菪酒硝石饮", "酒", "黄酒", "substance"],
  ["治产后烦闷及渴方", "酒", "黄酒", "substance"], ["治发背经验方", "酒", "黄酒", "substance"],
  ["葱姜煎", "葱", "葱白", "substance"], ["葱蜜散", "葱", "葱白", "substance"],
  ["螃蟹散", "蜜", "蜂蜜", "substance"],
  ["神仙粥", "醋", "米醋", "substance"], ["胞衣不下各方", "醋", "米醋", "substance"],
  ["治重舌经验方", "醋", "米醋", "substance"],
  ["神仙照水膏", "蜡", "蜂蜡", "substance"],
  ["绿豆饮", "盐", "食盐", "substance"], ["治耳病方", "盐", "食盐", "substance"],
  ["开盐方", "盐", "食盐", "substance"], ["治疥及疠疡风方", "盐", "食盐", "substance"],
  ["治胎死欲令出方", "盐", "食盐", "substance"], ["治众蛇螫人方", "盐", "食盐", "substance"],
  ["治霍乱转筋及杂治方", "盐", "食盐", "substance"], ["治霍乱转筋及杂治方", "醋", "米醋", "substance"],
  ["治面、粉刺、面诸方", "豉", "淡豆豉", "canonical"],
  ["治产后咳嗽、中风及心腹痛方", "豉", "淡豆豉", "canonical"],
  ["肠痈秘方", "草", "甘草", "canonical"], ["金锁比天膏", "草", "甘草", "canonical"],
];
// 非药味垃圾 token(抽取误入组成的动词/用法词),直接删除不进修复
const JUNK_REMOVE = { 木香顺气丸: ["汤", "用"] };
// 原 OCR 在「山甲十四片」处断行并吞掉后续多味；两个独立全文库的同方组成一致。
// 穿山甲仍不进入 T9 自动解析，因此修正文献身份不会绕开受保护物种/毒性门禁。
const FULL_COMPOSITION_REPLACEMENTS = {
  化痞消积膏: {
    ingredients: [
      "秦艽", "三棱", "莪术", "蜈蚣", "巴豆", "当归", "大黄", "黄连", "全蝎",
      "穿山甲", "木鳖子", "阿胶", "阿魏", "芦荟", "麝香", "片脑", "没药", "乳香",
    ],
    evidence: "《惠直堂经验方》卷四原文；Chinese Text Project 与中医世家同方组成交叉核验",
  },
};

const pass1 = JSON.parse(readFileSync(resolve(DIR, "repairs.json"), "utf-8"));
const pass2 = JSON.parse(readFileSync(resolve(DIR, "repairs-pass2.json"), "utf-8"));
const auto = JSON.parse(readFileSync(resolve(DIR, "pass1-split.json"), "utf-8")).auto;

const repairMap = new Map(); // name -> Map(from -> {to, evidence})
const addRepair = (name, from, to, evidence) => {
  if (DROP.has(`${name}|${from}`)) return;
  if (!repairMap.has(name)) repairMap.set(name, new Map());
  repairMap.get(name).set(from, { to, evidence });
};
for (const o of [...pass1, ...pass2]) {
  if (!o.ok) continue;
  for (const r of o.repairs || []) addRepair(o.name, r.from, r.to, r.evidence);
}
for (const a of auto) addRepair(a.name, a.from, a.to, a.evidence);
for (const [name, from, to, evidence] of CURATED) addRepair(name, from, to, evidence);

const supp = JSON.parse(readFileSync(SUPP, "utf-8"));
const applied = [], skipped = [];
for (const [name, repairs] of repairMap) {
  const e = supp.entries[name];
  if (!e) { skipped.push({ name, why: "no supplement entry" }); continue; }
  const fixList = (list) => (list || []).map((h) => {
    const r = repairs.get(h);
    return r ? r.to : h;
  }).filter((h) => !(JUNK_REMOVE[name] || []).includes(h));
  const before = JSON.stringify(e.ingredients);
  e.ingredients = fixList(e.ingredients);
  e.requiredIngredients = fixList(e.requiredIngredients);
  const remaining = (e.ingredients || []).filter((h) => typeof h === "string" && h.trim().length === 1);
  if (before !== JSON.stringify(e.ingredients)) {
    e.verification = [...(e.verification || []), {
      title: `OCR 缺字修复(${[...repairs.entries()].map(([f, r]) => `${f}→${r.to}`).join(",")};回源段/通行组成/物料归一,联网抽查核验)`,
      url: `urn:tcm-cdss:corrupt-herb-repair:20260725:${name}`,
      sourceRef: "CORRUPT-HERB-REPAIR-20260725",
    }];
    applied.push({ name, remainingSingles: remaining });
  }
}
for (const [name, replacement] of Object.entries(FULL_COMPOSITION_REPLACEMENTS)) {
  const e = supp.entries[name];
  if (!e) {
    skipped.push({ name, why: "no supplement entry for full composition replacement" });
    continue;
  }
  if (JSON.stringify(e.ingredients) === JSON.stringify(replacement.ingredients)) continue;
  e.ingredients = replacement.ingredients;
  e.verification = [...(e.verification || []), {
    title: `OCR 断行组成回补(${replacement.evidence})`,
    url: "https://ctext.org/wiki.pl?chapter=170623&if=gb&remap=gb",
    sourceRef: "CORRUPT-HERB-REPAIR-20260727",
  }];
  applied.push({
    name,
    remainingSingles: replacement.ingredients.filter(
      (herbName) => typeof herbName === "string" && herbName.trim().length === 1,
    ),
  });
}
writeFileSync(SUPP, JSON.stringify(supp, null, 2) + "\n");
const fullyClean = applied.filter((a) => a.remainingSingles.length === 0).length;
console.log(JSON.stringify({ repairSources: repairMap.size, applied: applied.length, fullyClean, stillFlagged: applied.length - fullyClean, skipped }));
writeFileSync(resolve(DIR, "applied.json"), JSON.stringify({ applied, skipped }, null, 2) + "\n");
