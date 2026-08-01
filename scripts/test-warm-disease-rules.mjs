// 温病辨证规则轨道：命中率与误报双向门禁。
//
// T13 此前 53 条规则全是六经维度，温病轨道为 0。而规则经 rankedDifferentiationRules(text, 4)
// 取 top-4 注入 M03/M04 提示词——缺轨道不是"少个标签"，是**湿温类病例模型没有推理轨道可走**，
// 只能靠词表碎片和检索结果猜。
//
// 这条套件钉三件事，每一件都对应上两轮踩过的坑：
//   1. 方名必须在 T8 受控目录内——上一轮草案引用过目录外的二甲复脉汤、神犀丹；
//   2. 温病病例必须真的命中温病规则——只留部分规则时，湿温例的首位规则会退化成
//      **方向相反的太阳伤寒条**（湿温忌汗，而太阳伤寒条问的正是发汗与否）；
//   3. 阴性对照必须零误报——触发词过宽会挤占仅有 4 格的注入预算。实测中
//      「心中大动」这种裸词曾让下焦风动条在心衰病例上误命中。
import assert from "node:assert/strict";
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { rankedDifferentiationRules } = await jiti.import("../src/lib/tcm-classic-inference.ts");
const readJson = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}`, import.meta.url), "utf8"));

const rulesAsset = readJson("tcm-differentiation-rules.json");
const source = readJson("tcm-warm-disease-rules.source.json");
const catalogNames = new Set(readJson("tcm-formula-governed-catalog.json").entries.map((entry) => entry.name));

const warmRules = rulesAsset.rules.filter((rule) => /^T13-WQXX-/.test(rule.id));
assert.equal(warmRules.length, source.rules.length,
  `温病规则未完整并入产物：源 ${source.rules.length} 条，产物 ${warmRules.length} 条`);
assert.ok(rulesAsset.rules.length > warmRules.length,
  "既有六经规则不得被温病轨道挤掉");

// 方名必须受控。规则渲染进提示词的是 resolves——上一轮把纠正只写在 question 散文里、
// resolves 仍留着错误候选，等于纠正没生效。
const ungoverned = warmRules.flatMap((rule) =>
  [...rule.resolves, ...(rule.discriminates || [])]
    .filter((name) => !catalogNames.has(name))
    .map((name) => `${rule.id}:${name}`));
assert.deepEqual([...new Set(ungoverned)], [],
  `温病规则引用了 T8 目录外的方名（提示词会渲染 resolves，目录外即无出处）：${ungoverned.join("、")}`);

// 治理留痕不进运行时资产。
assert.ok(!rulesAsset.rules.some((rule) => "groundingExcerpt" in rule),
  "groundingExcerpt 是治理留痕，不应出现在运行时规则资产里");
assert.ok(source.rules.every((rule) => typeof rule.groundingExcerpt === "string" && rule.groundingExcerpt.length > 10),
  "每条温病规则都必须带可回溯原文的 groundingExcerpt——这是上一轮凭记忆写出三条硬伤后加的纪律");

// sourceRefs 不能只是看起来像引用。对两个运行时古籍语料做一次流式反查：每个 # 后的
// 条文锚至少要有一个 8–12 字连续片段真实存在。使用滑窗是为了容忍 OCR 标点和条号差异，
// 但不允许仅凭书名/章名蒙混过关。
const normalizeEvidenceText = (value) => String(value || "")
  .replace(/[\s，。；：、,.!?！？“”‘’「」『』（）()\[\]〔〕…·#-]/g, "");
const citationTargets = source.rules.flatMap((rule) => rule.sourceRefs.map((sourceRef) => {
  const anchor = normalizeEvidenceText(sourceRef.split("#").slice(1).join("#"))
    .replace(/^[〇零一二三四五六七八九十百]+/, "");
  const fragments = [];
  for (let index = 0; index + 8 <= anchor.length; index += 4) {
    fragments.push(anchor.slice(index, index + 12));
  }
  return { ruleId: rule.id, sourceRef, fragments, matched: false };
}));
assert.ok(citationTargets.every((target) => target.fragments.length > 0),
  "每条 sourceRef 的 # 后必须带足够长的逐字条文锚");
for (const corpusName of [
  "tcm-classic-text-evidence.jsonl",
  "tcm-classic-text-evidence-tcmoc.jsonl",
]) {
  const lines = createInterface({
    input: createReadStream(new URL(`../src/data/${corpusName}`, import.meta.url)),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const normalized = normalizeEvidenceText(line);
    for (const target of citationTargets) {
      if (!target.matched && target.fragments.some((fragment) => normalized.includes(fragment))) {
        target.matched = true;
      }
    }
  }
}
assert.deepEqual(
  citationTargets.filter((target) => !target.matched).map((target) => `${target.ruleId}:${target.sourceRef}`),
  [],
  "温病规则 sourceRefs 必须能逐字回溯到已入库古籍证据",
);

// ─── 排序仿真：温病例必须命中，对照例必须零误报 ───
const WARM_CASES = [
  ["湿温(三仁候)", "头痛恶寒，身重疼痛，舌白不渴，胸闷不饥，午后身热，面色淡黄"],
  ["膜原(达原候)", "昼夜发热，日晡益甚，头疼身痛，苔白厚如积粉，脉不浮不沉而数"],
  ["卫气分界", "不恶寒反恶热，小便色黄，大渴，脉洪大"],
  ["营分", "舌绛而干，夜寐不安，时有谵语，不渴"],
  ["邪陷心包", "神昏谵语，舌蹇肢厥"],
  ["大头瘟", "咽肿，耳前耳后肿，颊肿，面正赤"],
  ["发斑", "发斑，斑色紫，大便燥结"],
];
for (const [label, text] of WARM_CASES) {
  const top = rankedDifferentiationRules(text, 4);
  assert.ok(top.some((rule) => /^T13-WQXX-/.test(rule.id)),
    `温病病例未命中温病轨道（模型将无轨可走）：${label} → [${top.map((r) => r.id).join(", ")}]`);
}

const CONTROL_CASES = [
  ["普通外感咳嗽", "咳嗽咳痰1周，无发热，纳可眠安"],
  ["心力衰竭", "活动后气促，双下肢水肿，心中大动，射血分数降低"],
  ["太阳伤寒", "发热恶寒，无汗，身痛，项背强，脉浮紧"],
  ["寒湿腰痛", "腰部酸痛3月，遇冷加重，无发热"],
];
for (const [label, text] of CONTROL_CASES) {
  const top = rankedDifferentiationRules(text, 4);
  const warmHits = top.filter((rule) => /^T13-WQXX-/.test(rule.id)).map((rule) => rule.id);
  assert.deepEqual(warmHits, [],
    `非温病病例被温病规则误占注入预算（只有 4 格）：${label} → ${warmHits.join("、")}`);
}

console.log(JSON.stringify({
  totalRules: rulesAsset.rules.length,
  warmDiseaseRules: warmRules.length,
  sixChannelRules: rulesAsset.rules.length - warmRules.length,
  warmCases: WARM_CASES.length,
  controlCases: CONTROL_CASES.length,
  failures: 0,
}));
