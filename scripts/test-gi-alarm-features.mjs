/**
 * 上消化道警示征象（alarm features）红旗判据。
 *
 * 【这条套件钉的是哪个客户缺陷】
 * 2026-08-13 鲁棒性压测用一份真实公开病案（胃癌术后放化疗，胃胀伴进食困难 10 月余、加重 7 天、
 * 呕吐黏液，病理示瘤床低分化腺癌浸润）打线上，结果是：
 *   safetyGate.redFlags = []、advisories = []，M03 按普通「胃气壅滞」出方，M05 只给「一般提示」。
 *
 * 查因：diagnosis-safety.ts 里「吞咽困难」**只**出现在上气道水肿（过敏性喉头水肿）规则内，
 * 作为气道功能线索；「恶性肿瘤 / 肿瘤 / 癌症 / 化疗 / 放疗」在该文件中一次都没出现过。
 * 而 m02-question-contract.ts 的上消化道追问原文是
 * 「是否出现吞咽困难或进行性卡顿、呕血或黑便、持续呕吐或不明原因体重下降？」——
 * **追问层逐条问，确定性门一条都接不住**。医生答「是」，红旗仍然为空。
 * 这就是本仓库反复出现的那类缺陷：同一判据两处各写各的。
 *
 * 【本套件的不变量】
 *   1. 四条成立路径各自成立（梗阻征象 / 进食困难带进展 / 肿瘤史+当前消化症状 / 不明原因消瘦）；
 *   2. 误报防线：甲方 P0 病例的否定式原文、纳呆、普通便秘、普通反流、牙痛致进食困难、
 *      癌胚抗原这类检验名，一条都不许触发——误报一次，医生就会开始忽略所有红旗；
 *   3. 肿瘤史必须**允许历史性陈述**（「食管癌术后放化疗」本身就是历史），但仍要排除
 *      「否认肿瘤病史」与「母亲患胃癌」；
 *   4. **两处同源**：M02 追问句里点名的每个警示征象，都必须能被本判据接住。
 *      这一条是防漂移的关键——它才是上面那个缺陷的根，不补它，下次加问句照样会漏。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});

const { withSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");

const BASE = {
  id: "gi-alarm-suite", phase: "diagnose", patient: { sex: "男", age: 50 },
  tongue: "舌淡红苔薄白", pulse: "脉弦",
  vitals: "T36.5℃ P76次/分 R18次/分 BP120/76mmHg",
  medicationHistory: "近期未服药", allergyHistory: "否认药物、食物过敏",
  questionRounds: 1, maxQuestionRounds: 1, conversation: [],
  diagnosis: "", prescription: "", riskAssessment: "",
};

const ALARM = /上消化道警示征象/;
function fires({ complaint, present, past = "" }) {
  const state = {
    ...BASE,
    chiefComplaint: complaint,
    symptoms: { general: present ?? complaint, tcmFourExams: "" },
    pastHistory: past,
  };
  return withSafetyGate(state).safetyGate.redFlags.some((flag) => ALARM.test(flag));
}

// ── 1. 四条成立路径 ────────────────────────────────────────────────────────
const MUST_FIRE = [
  {
    label: "线上实测原案：胃癌术后 + 进食困难10月余加重7天",
    complaint: "胃胀伴进食困难10月余，加重7天",
    present: "现胃脘胀满、进食困难、腹胀、呕吐黏液、纳少、寐差、大便2~3日一行。",
    past: "胃癌，已行手术及放化疗",
  },
  { label: "新发吞咽困难本身即内镜指征", complaint: "进行性吞咽困难2月" },
  { label: "哽噎/噎膈类表述", complaint: "进食哽噎感1月，逐渐加重" },
  { label: "肿瘤史写在既往史字段 + 当前消化症状", complaint: "上腹胀满3月", past: "食管癌术后放化疗" },
  { label: "肿瘤史写在现病史 + 当前消化症状", complaint: "上腹胀满3月", present: "上腹胀满3月。既往食管癌术后放化疗。" },
  { label: "不明原因体重下降带数值", complaint: "胃脘隐痛半年，不明原因体重下降6kg" },
  { label: "进行性消瘦", complaint: "纳差乏力2月，进行性消瘦" },
  {
    // 病种白名单必然漏：第一版列了胃癌/食管癌/结直肠癌…，「子宫内膜癌」不在其中，整条判据静默失效。
    label: "非消化道恶性肿瘤 + 警示级消化道表现（肠梗阻史）",
    complaint: "胃胀痛1周",
    present: "胃胀痛1周，进食后加重，大便偏干。",
    past: "子宫内膜癌（2008年3月手术）史，肠梗阻史",
  },
];
for (const item of MUST_FIRE) {
  assert.ok(fires(item), `应触发上消化道警示征象红旗：${item.label}｜${item.complaint}`);
}

// ── 2. 误报防线 ────────────────────────────────────────────────────────────
const MUST_NOT_FIRE = [
  {
    label: "甲方 P0 病例的否定式原文（否定读成阳性会把普通门诊病例打成红旗）",
    complaint: "胃脘隐痛伴口干3月，加重2周",
    present: "胃脘隐隐灼痛，饥不欲食，口干咽燥。无呕血黑便，无消瘦，无吞咽困难，无发热。",
  },
  { label: "纳呆是普通中医描述，不是警示征象", complaint: "胃脘隐痛，饥不欲食，纳少，食欲差" },
  { label: "普通便秘", complaint: "大便干结2-3日一行，腹胀" },
  { label: "普通反流，无梗阻征象", complaint: "反酸烧心2月，餐后加重" },
  { label: "明确否认肿瘤病史", complaint: "胃脘胀满3月", past: "否认肿瘤病史，否认手术史" },
  { label: "家族史不是本人病史", complaint: "上腹胀满3月", past: "母亲患胃癌，本人否认肿瘤病史" },
  { label: "进食困难无进展线索（牙痛所致）", complaint: "牙痛致进食困难2天" },
  { label: "检验项目名不得当成肿瘤病史", complaint: "体检发现癌胚抗原轻度升高，胃脘不适" },
  { label: "肿瘤史但当前无消化道症状", complaint: "失眠3月", present: "入睡困难3月，多梦易醒", past: "乳腺癌术后放化疗" },
  {
    // 分档的意义就在这条：非消化道肿瘤 + 普通腹胀不触发。
    // 不分档的话，十年前的乳腺癌幸存者偶发腹胀会永远挂着红旗，医生很快就不再看红旗了。
    label: "非消化道肿瘤 + 普通腹胀（非警示级）不得触发",
    complaint: "腹胀2周", present: "腹胀2周，食后明显，排便正常", past: "乳腺癌术后10年，定期复查未见复发",
  },
  { label: "防癌体检不是肿瘤病史", complaint: "胃脘不适", present: "胃脘不适2周，近期防癌体检未见异常", past: "" },
];
for (const item of MUST_NOT_FIRE) {
  assert.ok(!fires(item), `不得触发上消化道警示征象红旗：${item.label}｜${item.complaint}`);
}

// ── 3. 治理表同源 ──────────────────────────────────────────────────────────
const lexicon = JSON.parse(readFileSync(path.join(repoRoot, "src/data/redflag-triage-lexicon.json"), "utf8"));
const giAlarm = lexicon.categoryRules.find((rule) => rule.id === "gi_alarm");
assert.ok(giAlarm, "受治理红旗表必须含 gi_alarm 类别——判据词表不得散落在代码里");
assert.ok(giAlarm.symptoms.includes("吞咽困难"), "gi_alarm 症状词表必须含吞咽困难");
assert.ok(giAlarm.dangerCompanions.some((term) => /胃癌|恶性肿瘤/.test(term)), "gi_alarm 必须把恶性肿瘤病史列为危险伴随");

// ── 4. 防漂移：M02 追问里点名的警示征象，确定性门必须接得住 ────────────────
// 这条是缺陷的根。上一版就是「M02 问了、门没规则」，医生答『是』也无人接。
const m02Source = readFileSync(path.join(repoRoot, "src/lib/m02-question-contract.ts"), "utf8");
const upperGiQuestion = m02Source.match(/question:\s*"([^"]*吞咽困难[^"]*)"/);
assert.ok(upperGiQuestion, "m02-question-contract.ts 里应仍有上消化道警示征象追问句；措辞变了请同步本套件");
const ASKED_FEATURES = [
  { term: "吞咽困难", probe: { complaint: "进行性吞咽困难2月" } },
  { term: "进行性卡顿", probe: { complaint: "进食哽噎感1月，逐渐加重" } },
  { term: "持续呕吐", probe: { complaint: "上腹胀满3月", past: "食管癌术后放化疗" } },
  { term: "体重下降", probe: { complaint: "胃脘隐痛半年，不明原因体重下降6kg" } },
];
for (const feature of ASKED_FEATURES) {
  if (!upperGiQuestion[1].includes(feature.term)) continue;
  assert.ok(
    fires(feature.probe),
    `M02 追问点名了「${feature.term}」，确定性门却接不住——同一判据两处各写各的，正是本套件要防的那类缺陷`,
  );
}
// ── 5. 咖啡样呕吐物的构词式表达 ──────────────────────────────────────────────
// 同一次压测里的第二个同类缺口：真实妊娠剧吐病案原文写「吐出咖啡色黏液」「吐出咖啡色液体」，
// 确定性层 redFlags 为 0——词表只有「咖啡样呕吐物」「呕咖啡样物」两个完整词。
// 该例线上能出红旗靠的是模型语义回补层，而那层按设计只能追加、且依赖模型可用
//（2026-08-12 主模型欠费停摆 8 小时，同一份病历会一条红旗都没有）。
// 更直白的自相矛盾：否定扫描的同义词组早就列了「呕咖啡色液体」——否定侧认得，阳性侧不认得。
function bleedFires({ complaint, past = "" }) {
  return withSafetyGate({
    ...BASE, patient: { sex: "女", age: 28 },
    chiefComplaint: complaint, symptoms: { general: complaint, tcmFourExams: "" }, pastHistory: past,
  }).safetyGate.redFlags.some((flag) => /消化道出血/.test(flag));
}
const COFFEE_MUST_FIRE = [
  ["词表原词", "呕吐3周，呕吐咖啡样呕吐物，不能进食"],
  ["线上实测原案写法：咖啡色液体", "频繁恶心呕吐3周，吐出咖啡色液体，食入即吐，不能进食"],
  ["咖啡色黏液", "频繁恶心呕吐3周，吐出咖啡色黏液，食入即吐"],
  ["咖啡样物", "呕吐3周，呕出咖啡样物"],
  ["呕吐物呈咖啡色", "呕吐3天，呕吐物呈咖啡色"],
  ["呕血+黑便仍由 gi_bleed 承接", "反复呕血2次伴黑便，头晕乏力"],
];
for (const [label, complaint] of COFFEE_MUST_FIRE) {
  assert.ok(bleedFires({ complaint }), `应触发消化道出血红旗：${label}｜${complaint}`);
}
const COFFEE_MUST_NOT_FIRE = [
  ["整句否认", "呕吐3周。否认呕血，否认吐咖啡色液体，否认黑便"],
  // 跨分句会把旧血性阴道分泌物读成上消化道出血——那是产科线索，判错方向比漏判更糟。
  ["跨分句的阴道分泌物不得误读为呕吐物", "呕吐3天，阴道流出咖啡色分泌物"],
  ["喝咖啡不是出血", "喝咖啡后胃脘不适，偶有恶心呕吐"],
];
for (const [label, complaint] of COFFEE_MUST_NOT_FIRE) {
  assert.ok(!bleedFires({ complaint }), `不得触发消化道出血红旗：${label}｜${complaint}`);
}

// ── 语义回补层必须也认得 gi_alarm ──────────────────────────────────────────
// 【钉的是什么】受治理词表有 18 类，clinical-facts 的 BACKSTOP_RED_FLAG_CATEGORIES 此前只有 17 类，
// 唯独缺 gi_alarm。后果不是少一个标签：
//  · buildClinicalFactsExtractionPrompt 用该表生成「类目键只能取以下之一」；
//  · 同一段提示词却把全部 18 类的受治理规则（含 gi_alarm）喂给模型；
//  · 模型看得到规则、选不了键；硬选也会在解析处被 `!(category in ...)` 静默丢弃。
// 于是整个上消化道警示征象类别在**语义回补层结构性失明**——而该层的全部意义
// 正是接住确定性层漏不到的口语表述（主模型欠费停摆那 8 小时靠的就是确定性层，
// 反过来口语表述靠的就是这一层）。
// 2026-08-16：确定性层与词表当天已加 gi_alarm，本表没跟上，同一修复只做了一半。
{
  const factsSource = readFileSync(path.join(repoRoot, "src/lib/clinical-facts.ts"), "utf8");
  const start = factsSource.indexOf("export const BACKSTOP_RED_FLAG_CATEGORIES");
  assert.ok(start >= 0, "找不到 BACKSTOP_RED_FLAG_CATEGORIES 声明");
  // 该对象以 `} as const;` 结尾，不是 `};`——按 `};` 切会一路切进 RED_FLAG_MESSAGE。
  const body = factsSource.slice(start, factsSource.indexOf("\n} as const;", start));
  const codeCategories = [...body.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
  // 守卫：切片一旦越界，会把紧随其后的 RED_FLAG_MESSAGE 一并算进来，
  // 于是「从第一张表里删掉一类」照样能在第二张表里找到，整条断言变成空转。
  // 首版就是这么写的，反证当场发现它抓不住——去重后数量翻倍是唯一可靠的越界信号。
  assert.equal(
    new Set(codeCategories).size, codeCategories.length,
    `切片越界：类目出现重复，说明切到了下一张表。实得 ${codeCategories.length} 项／去重后 ${new Set(codeCategories).size} 项`,
  );
  const lexiconCategories = lexicon.categoryRules.map((rule) => rule.id);
  const missing = lexiconCategories.filter((id) => !codeCategories.includes(id));
  assert.deepEqual(
    missing, [],
    `受治理词表里的每一类都必须在语义回补层的类目表里；缺失：${JSON.stringify(missing)}。`
    + "缺一类不是少一个标签——模型会被喂到该类的受治理规则却选不了它的键，"
    + "返回值随后被静默丢弃，该类别在语义层整类失明。",
  );
  assert.ok(
    codeCategories.includes("gi_alarm"),
    "gi_alarm 必须在语义回补层类目表内（2026-08-16 确定性层已加，本表曾漏）",
  );
}

console.log("test-gi-alarm-features: OK", {
  alarmMustFire: MUST_FIRE.length,
  alarmMustNotFire: MUST_NOT_FIRE.length,
  askedFeaturesChecked: ASKED_FEATURES.filter((f) => upperGiQuestion[1].includes(f.term)).length,
  coffeeMustFire: COFFEE_MUST_FIRE.length,
  coffeeMustNotFire: COFFEE_MUST_NOT_FIRE.length,
});
