// PHI 脱敏与临床术语的撞车回归(2026-08-05)。
//
// 甲方实测链路:西医「支持依据」只剩半句病历原文、总体病机缺节点。追下去发现问题不在 M03,
// 而在**送模型之前**——脱敏规则把临床事实当人名抹掉了,模型根本没看到:
//
//   「主诉：周身出现块状皮疹」→「主诉：[已脱敏]出现块状皮疹」
//    周在姓氏表、身是 1 字、出现在叙述动词表 ⇒ 命中「姓氏字+1~2字+叙述动词」分支。
//   「患者，女，36岁」→「[已脱敏]，女，36岁」
//    「患者」是通用指代词,不携带任何身份信息,抹掉只制造噪声。
//
// 20 例线上语料实测 13 例命中,周身/全身/白苔/黄疸/皮疹/干呕这些词**都不在任何受控词表里**,
// 靠补词表穷举不完。判据改成**位置**:本系统病历按字段录入,姓名在 patient 字段或带显式
// 「姓名：」标签,不会紧跟在「主诉：」「四诊：」「舌：」之后。
//
// 本套件双向钉死,任一方向失守都不可接受:
//  · 临床事实不得被当人名抹掉(抹掉 = 模型看不到 = 后面每一层都补不回来);
//  · 真实姓名必须照常脱敏(漏掉 = PHI 泄露)。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");

const scrub = (text) => {
  const state = {
    id: "phi-collision-test",
    patient: { sex: "女", age: 30 },
    chiefComplaint: text,
    symptoms: { 现病史: text },
    tongue: "",
    pulse: "",
    conversation: [],
    vitals: {},
  };
  return String(safety.sanitizeCaseStateForModel(state).symptoms?.现病史 || "");
};

const failures = [];
let keptCount = 0;
let redactedCount = 0;
const expectKept = (text, why) => {
  keptCount += 1;
  const out = scrub(text);
  if (out.includes("脱敏")) failures.push({ kind: "clinical_fact_lost", text, why, out });
};
const expectRedacted = (text, why) => {
  redactedCount += 1;
  const out = scrub(text);
  if (!out.includes("脱敏")) failures.push({ kind: "phi_leak", text, why, out });
};

// ── 一、临床字段标签之后的词不得被当人名(甲方缺陷本体) ─────────────────
expectKept("主诉：周身出现块状皮疹已持续一年多", "周身是病位事实,丢了会改变辨证");
expectKept("四诊：舌质淡红，苔薄白，脉细数，风团红痒", "四诊原文不得被裁剪");
expectKept("现病史：干呕反复发作3日", "干呕:干在姓氏表");
expectKept("症见：白苔满布，口淡不渴", "白苔:白在姓氏表");
expectKept("查体：黄疸出现于巩膜及全身皮肤", "黄疸/全身:黄在姓氏表");

// ── 一之二、**无标签**的字段值同样不得被当人名（2026-09-08 用真函数复现的缺口） ──────────
// 结构化字段（chiefComplaint / symptoms.* / hisRecord.fields.*）存的是裸值，没有「主诉：」前缀；
// normalizePresentHistoryText 还会主动剥掉「现病史：」，所以「标签冒号之后」护不住字段路径。
// 裸值由 phi-sanitizer 的受治理临床词形（疾病/病位/望诊词表 + phi-clinical-lexical-grammar 构词组）消歧。
expectKept("周身出现块状皮疹3天", "周身：周在姓氏表，出现在线索表——无标签字段值");
expectKept("反复咳嗽3天，周身出现块状皮疹", "标点之后的同一形态");
expectKept("全身发热3天", "全身 + 症状线索");
expectKept("常有心悸", "常有 + 症状线索");
expectKept("黄疸出现于巩膜及全身皮肤", "黄疸 + 出现");
expectKept("干呕发生于晨起", "干呕 + 发生");
expectKept("高热出现于午后", "高热 + 出现");

// ── 一之三、17,270 例现代医案叙述里实测被抹掉的临床词类（2026-09-11） ──────────────────
// 仅凭疾病/病位/望诊词表时，50,448 段主诉/四诊/病机叙述里仍有 851 处临床词被当姓名抹掉。
// 每个构词组取语料原句一条：侧别、经期时相、劳力诱因、黄疸部位丢失都会改变分诊或辨证。
expectKept("经行腹痛4-5年", "经行：月经时相（menstrual_phase）");
expectKept("7日，经量很少，经期腹痛，畏寒", "经期：月经时相");
expectKept("左侧头痛持续半个月", "左侧：侧别（body_orientation）");
expectKept("走150米左右后，双下肢出现酸困疼痛", "双下肢：侧别+双字部位（body_orientation_compound）");
expectKept("左下腹痛和频繁呃逆14天", "左下：象限（body_quadrant）");
expectKept("舌质偏淡，边缘有紫点，苔薄腻", "边缘：舌诊分区（tongue_region）");
expectKept("偶有胁下胀痛，劳累后出现胸闷、气短", "劳累后：劳力诱因 + 功能语素（lexemeFollowers）");
expectKept("胃口和睡眠良好，巩膜有黄染", "巩膜：体表部位（surface_anatomy）");
expectKept("经常咳嗽并咯血丝痰", "经常：频度副词（frequency_adverb）");
expectKept("头晕，右胁不舒，时觉心悸", "时觉：频度+感知（frequency_predicate）");
expectKept("干咳已有2个月", "干咳已：临床词 + 功能语素");
expectKept("血块，质地稀薄。全身伴有气短乏力", "全身伴：临床词 + 功能语素");
expectKept("瘀血停滞在局部，郁而发热", "郁而：病机（stagnation_pathomechanism）");

// ── 二、通用指代词不是姓名 ────────────────────────────────────
expectKept("患者，女，36岁，已婚。两次月经中间，阴道少量出血", "「患者」不携带身份信息");
expectKept("患儿，男，5岁。发热2天", "「患儿」同上");

// ── 三、真实姓名必须照常脱敏(收紧不得变成泄露) ────────────────────
expectRedacted("王某，女性，26岁。1个月前出现发热", "某字名");
expectRedacted("张三昨夜失眠", "姓名 + 叙述动词,无临床标签前缀");
expectRedacted("李四近日头痛", "双字名 + 时间副词线索");
expectRedacted("王五诉胸痛3天", "双字名 + 报告动词线索");
expectRedacted("周建国出现块状皮疹", "三字名 + 通用动词：三字候选不受双字守卫影响");
expectRedacted("欧阳明月今日来诊", "复姓 + 叙述线索");
expectRedacted("患者张三失眠", "指代词之后的双字名维持原判（test:clinical-grounding 同钉）");
expectRedacted("患者王小明今日来诊", "指代词标签 + 姓名");
expectRedacted("姓名：李建国，男，52岁", "显式姓名标签");
expectRedacted("联系人：陈美玲，电话13800138000", "联系人标签 + 手机号");
expectRedacted("患者赵德海，男，68岁，因胸痛来诊", "姓氏 + 人口学邻接");

// ── 四、构词消歧不得打开姓名泄漏（2026-09-11 隐私反证） ────────────────────────────
// 构词组按「姓氏字 + 常见名字用字」同形逐条剔除过：平素/常发/时发/劳力/暴发/后天/卫阳
// 与真实姓名同形，按隐私优先维持脱敏。三字守卫只在第三字属于功能语素时放行，
// 疾病词表的「强中」即便是词条，「强中华」仍须脱敏。
for (const [text, why] of [
  ["平素芬出现胸痛", "平素 与 平姓+素 同形，刻意不收"],
  ["常发出现胸痛", "常发 与 常姓+发 同形，刻意不收"],
  ["劳力患糖尿病", "劳力 与 劳姓+力 同形，刻意不收"],
  ["暴发有高血压", "暴发 与 暴姓+发 同形，刻意不收"],
  ["卫阳头痛3天", "卫阳 与 卫姓+阳 同形，刻意不收"],
  ["强中华出现胸痛", "三字守卫：第三字「华」是名字用字，不属于功能语素"],
]) expectRedacted(text, why);
// 构词组起首的每个姓氏字 × 常见名字 × 既有叙述句式（test:clinical-grounding 同形）：一个都不得漏。
// 「前/右/两」不在姓氏表内，本就不会被当姓名，不列入。
const lexicalPrefixSurnames = [..."后左双单全周通经常时平劳郁水卫伏余相高干暴易边关巩皮红麻包严明容应都尤终曾向夏苏连充黄"];
const commonGivenNames = [..."伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀霞刚英华玲丹萍鹏辉飞鑫波斌宇浩凯健俊阳建亮成佳雪慧婷倩琳颖晶洁梅莉兰凤玉珍春梦云晨文博志海峰东新永生光天德福荣贵国红燕琴发力素"]
  .concat(["建国", "秀英", "小明", "志强", "海燕", "素芬", "中华", "德明", "卫东", "春生"]);
for (const surname of lexicalPrefixSurnames) {
  for (const given of commonGivenNames) {
    for (const template of ["{n}出现胸痛", "{n}有高血压", "反复咳嗽3天，{n}患糖尿病"]) {
      const text = template.replace("{n}", surname + given);
      const out = scrub(text);
      redactedCount += 1;
      if (out.includes(surname + given)) failures.push({ kind: "phi_leak", text, why: "构词组起首姓氏 × 常见名字", out });
    }
  }
}

// ── 五、姓氏表按百家姓整理，漏了一批现代高频姓（2026-09-11 实测） ─────────────────────
// 肖（前 30 位）/付/闫/覃/岳 等此前在抬头、患者X、家属X、本例X、裸叙述五种句式里全部原样留存，
// 只有显式「姓名：」标签拦得住。补入的姓均经 17,270 例语料实测零新增临床误脱敏；
// 初/门/来/原/阳/海/迟/薄/芦/蒲/鹿/麦 等首字常起临床词（初诊/门诊/来诊/阳性/迟脉/薄苔…）的刻意不补。
// 「白」只补进强上下文规则（抬头/本例X/家属X）：裸叙述规则补白会吃掉「白天咳嗽较重，夜间较轻」
// 这类昼夜节律事实（语料 22 处），而「白天」又与白姓+常见名字同形不能入词表——交 owner 裁定。
for (const name of ["肖伟", "付强", "闫明", "覃丽", "岳峰", "兰芳", "涂军", "卓凡", "帅杰", "晋华"]) {
  for (const template of ["{n}，男，45岁，头痛3天", "患者{n}头痛3天", "家属{n}代述病情", "{n}出现胸痛", "本例{n}既往有高血压"]) {
    const text = template.replace("{n}", name);
    redactedCount += 1;
    const out = scrub(text);
    if (out.includes(name)) failures.push({ kind: "phi_leak", text, why: "现代高频姓", out });
  }
}
for (const template of ["白雪，女，32岁，头痛3天", "家属白雪代述病情", "本例白雪既往有高血压"]) {
  redactedCount += 1;
  const out = scrub(template);
  if (out.includes("白雪")) failures.push({ kind: "phi_leak", text: template, why: "白姓：强上下文规则", out });
}
expectKept("初诊，女，32岁，头痛3天", "初 不补入姓氏表：初诊");
expectKept("咳嗽呈阵作性，白天咳嗽较重，夜间较轻", "白 不补入裸叙述规则：白天");

if (failures.length > 0) {
  console.error(JSON.stringify({ failures }, null, 2));
}
assert.equal(
  failures.length, 0,
  `PHI/临床术语撞车回归失败 ${failures.length} 项。clinical_fact_lost = 临床事实被当人名抹掉` +
  `(模型看不到,后面补不回来);phi_leak = 真实姓名未脱敏(隐私泄露)。两类都不可接受。`,
);

console.log(JSON.stringify({
  clinicalFactsPreserved: keptCount,
  realNamesRedacted: redactedCount,
  failures: 0,
}));
