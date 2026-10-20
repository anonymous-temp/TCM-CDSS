// 10/20 第十轮 WP10-PHI：脱敏把临床词形当姓名抹掉（第九轮 M03/M04 输出 189,040 串里 769 串被改写）。
//
// 每条断言都带隐私反证（记录见 ~/runlogs/r1018/work/r1022/counterproofs.txt，前缀 10/phi）。
// 两个方向的量尺脚本在 ~/runlogs/r1018/work/r1022/phi/（scan2.mjs / corpus-fp.mjs / leak.mjs），
// 本套件钉住的是它们量出来的结论：
//   · 误吃：输出语料 769 → 248 串（其中姓名规则误吃 660 → 139；职业泛化 104、X某类 5 不归本轮），余下是经典引文、单例与姓名同形词；
//   · 泄漏：464 个姓 × 546 个常见名 × 22 个句式（557 万次）泄漏集合差为空。
//
//   1 查+检查部位（查体/查舌质/查咽部…有无）          2 指令动词（符合/明确/解释/关注/须辨/尚缺/尚无/尚未）
//   3 应及时/应优先/应置/应当                          4 连声/相比/后者以/耿耿
//   5 易与/易混；常不/常因                              6 黎明前/黎明时（五更泻）
//   7 暴食/暴饮 + 后                                    8 宫口、黄涕、丛集性、经筋、强痉
//   9 于夏季/于外院/于我院；曾多次/曾反复；平时常        10 水气为患/水饮留于；郁热结于/辛热积于（病机）
//   11 皮损位于/麻木位于（位/限）+ 主语/关系前缀与叙述规则共用一条词形判据
//   12 抬头「高龄男性」                                  13 方义起句「方中有人参」（带上下文）
//   14 左小腹痛（部位词跨候选边界）
//   15 隐私总反证：新词条首字姓 × 常见名 × 句式，一个都不能放出

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const phi = await jiti.import("../src/lib/phi-sanitizer.ts");
const persistence = await jiti.import("../src/lib/browser-case-persistence.ts");
const lexemes = JSON.parse(readFileSync(new URL("../src/data/phi-clinical-lexemes.json", import.meta.url), "utf8"));

const scrub = (text) => safety.sanitizeFreeTextForModel(text);
const keepAll = (texts, label) => {
  for (const text of texts) assert.equal(scrub(text), text, `${label}：临床原句不应被改写\n  ${text}\n  → ${scrub(text)}`);
};
const redactAll = (texts, label) => {
  for (const text of texts) assert.match(scrub(text), /已脱敏/, `${label}：姓名必须照旧脱敏\n  ${text}\n  → ${scrub(text)}`);
};

await check("1.1 查+检查部位+有无：建议核实/查体指令不再被当成「查姓 + 名字」（160 处）；「查」姓真姓名照旧脱敏", () => {
  keepAll([
    "查体有无皮疹及胸腹部压痛", "查舌质有无紫暗瘀斑", "查看有无原发感染灶", "查颈前有无肿大、有无压痛", "查咽部有无化脓及扁桃体肿大",
    "查腹部有无胀满青筋", "查下肢有无浮肿", "查舌象有无舌红少苔", "查皮肤有无斑点瘀斑", "查关节有无肿胀压痛", "查体看有无水疱及脱屑",
    "建议核实：查乳房有无红肿硬结；查肛周有无红肿压痛", "患者近日胃痛，查体有无上腹压痛待记录",
  ], "查+部位");
  redactAll(["查伟有高血压", "查芳近日咳嗽", "患者查明出现胸痛", "查建国诉头痛3天", "家属查强代述病情", "查丽，女，30岁，头痛"], "查姓真名");
});

await check("1.2 对照：「查」之外的姓 + 同一部位词不是词形（部位词不单独放宽）", () => {
  redactAll(["王体有无皮疹", "张舌质有无紫暗", "李咽部有无化脓"], "他姓 + 部位");
});

await check("2.1 指令动词：符合/明确/解释/关注/须辨/尚缺/尚无/尚未 + 有无/症状（鉴别与问诊建议，约 70 处）", () => {
  keepAll([
    "劳累后加重，功能受损，符合失眠障碍；心烦易怒", "头痛性质不典型，符合偏头痛先兆模式", "用药情况，明确有无及具体药物",
    "明确腹痛性质、部位及诱因", "明确病因诱因后再行评估", "解释发热与卡他症状的关系", "关注有无血便、体重下降",
    "外伤肿痛，须辨有无骨折", "尚缺头痛部位、性质及伴随症状", "尚缺上腹痛烧灼感与餐后关系", "尚无近期复查结果", "尚未出现发热",
  ], "指令动词");
  redactAll(["符伟有高血压", "明华出现胸痛", "解伟诉头痛3天", "关芳近日咳嗽", "须明诉胸痛", "尚伟患糖尿病", "尚强近日咳嗽", "患者符芳失眠", "病人明伟有高血压"], "指令动词姓真名");
  // 三字守卫：词形 + 非功能字的第三字仍是名字用字
  redactAll(["符合华有高血压", "明确华出现胸痛", "尚缺强近日咳嗽"], "三字守卫");
});

await check("3.1 应及时/应优先/应置/应当（复诊与保存建议）", () => {
  keepAll(["心悸胸闷，应及时就诊评估。", "睡眠差，应优先就诊并复查", "药物切勿受热，应置于阴凉处保存", "诸脉浮数，应当发热，而反洒淅恶寒"], "应+副词");
  redactAll(["应伟有高血压", "应芳近日咳嗽", "患者应明出现胸痛"], "应姓真名");
});

await check("4.1 连声/相比/后者以/耿耿：鉴别叙述与成语", () => {
  keepAll(["连声咳嗽、咳后咯痰", "与年轻患者相比，老年患者症状不典型", "两者需区分，后者以发热为主而无咳嗽", "心情抑郁，耿耿于怀，难以疏解"], "连接词");
  redactAll(["连伟出现胸痛", "相芳有高血压", "耿伟近日咳嗽", "患者连明失眠"], "连接词姓真名");
});

await check("5.1 易与/易混、常不/常因：鉴别要点与发作规律（发热与否是鉴别点）；常发/时发仍与姓+发同形、照旧脱敏", () => {
  keepAll(["以咳为主症，易与咳嗽病混淆", "部位相邻，易混称", "反复发作，常不发热", "头痛更明显，常因头痛发作不能正常工作"], "易与/常不");
  redactAll(["易伟有高血压", "易芳近日咳嗽", "常伟出现胸痛", "常发出现胸痛", "时发有高血压"], "易/常姓真名");
});

await check("6.1 黎明前/黎明时：五更泻的关键辨证点；「黎明」本身是真实常见姓名，照旧脱敏", () => {
  keepAll(["黎明前腹痛即泻，形寒肢冷", "每于黎明时腹痛腹泻，每天1次", "患者黎明前腹痛、腹泻已有4年"], "黎明前");
  redactAll(["黎明近日咳嗽", "黎明诉头痛3天", "黎明出现胸痛", "黎明有高血压"], "黎明姓名");
});

await check("7.1 暴食后/暴饮后：诱因；暴发仍与暴姓+发同形", () => {
  keepAll(["暴食后出现胃脘胀痛", "暴饮后腹痛，呕吐2次"], "暴食");
  redactAll(["暴发有高血压", "暴伟出现胸痛"], "暴姓");
});

await check("8.1 宫口/黄涕/丛集性/经筋/强痉：各一类以姓氏字起首的体征与病名", () => {
  keepAll(["宫口有血块堵塞，小腹坠痛", "黄涕伴头痛数日", "黄涕头痛需排除鼻窦炎", "丛集性头痛，眼眶周围剧痛", "气血亏虚，经筋失于温煦", "半身不遂为主，强痉限于偏侧，非全身"], "体征病名");
  redactAll(["宫伟有高血压", "黄伟近日咳嗽", "丛伟出现胸痛", "经伟有高血压", "强伟诉头痛3天"], "体征首字姓真名");
});

await check("9.1 于夏季/于外院/于我院（起病季节与就诊地点）、曾多次/曾反复/曾数次（既往发作次数）、平时常", () => {
  keepAll(["于夏季发热，2～3天", "患者于外院就诊，诊断为冠心病", "既往体健，于我院就诊", "既往体健，曾多次出现不明显原因尿频", "曾反复出现咯血", "平时常有关节酸痛"], "地点/次数");
  redactAll(["于伟有高血压", "于明近日咳嗽", "曾伟有高血压", "曾芳近日咳嗽", "平素芬出现胸痛", "平时华有高血压"], "于/曾/平姓真名");
});

await check("10.1 病机叙述：水气为患/水饮留于、郁热结于、辛热积于（第九轮 病历7「辛热积于胃腑」被抹 → pathogenesis_drift → 非剂量页）", () => {
  keepAll([
    "水气为患，须分脏腑", "水湿为患，需辨有无阳虚", "水饮留于胃肠，走于肠间", "郁热结于胸膈，扰及心神", "余热积于下焦",
    "长期饮食肥甘、火锅白酒，辛热积于胃腑，胃火炽盛", "嗜食辛辣，辛温蕴于中焦",
  ], "病机");
  redactAll(["辛伟有高血压", "辛芳近日咳嗽", "郁强有高血压", "余伟近日咳嗽", "水华出现胸痛", "辛热华出现胸痛", "水湿华出现胸痛", "郁热强有高血压"], "病机首字姓真名");
  // 病机文字经送 M04 前的脱敏必须逐字不变（否则签名的 M03 病机与 M04 抄回的对不上）
  const pathogenesis = "患者高龄，嗜食肥甘，火锅白酒，辛热积于胃腑，胃火炽盛，郁热结于胸膈，水饮留于胃肠";
  assert.equal(scrub(pathogenesis), pathogenesis);
});

await check("11.1 皮损位于/麻木位于/红肿位于/皮损限于（位/限属功能语素）；主语前缀「本例X」与关系前缀「患者X」与叙述规则共用一条词形判据", () => {
  keepAll(["皮损位于手背等暴露部位", "麻木位于上臂及颈肩", "红肿位于咽喉，伴吞咽痛", "皮疹位于颜面躯干", "皮损限于日晒暴露部位"], "位/限");
  // 主语前缀规则：此前只认整词，词形 + 语素豁免轮不到
  keepAll(["本例水肿起于眼睑，伴少尿", "本例关节未诉肿大变形", "本例皮损对称分布于面部", "本例皮损位于面部", "本例红肿位于咽喉", "本例黄涕伴头痛数日"], "主语前缀 + 词形语素");
  assert.equal(phi.scrubSubjectPrefixedName("本例水肿起于眼睑"), "本例水肿起于眼睑");
  assert.equal(phi.scrubSubjectPrefixedName("本例皮损位于面部"), "本例皮损位于面部");
  // 对照：三字守卫在三处一致——前两字是词形、第三字是名字用字，仍是姓名
  assert.match(scrub("本例强中华有高血压"), /已脱敏/);
  assert.match(scrub("患者强中华，男，68岁"), /已脱敏/);
  assert.match(scrub("强中华出现胸痛"), /已脱敏/);
  assert.match(phi.scrubSubjectPrefixedName("本例强中华有高血压"), /已脱敏/);
  assert.match(phi.scrubRelationPrefixedName("家属强中华代述病情"), /已脱敏/);
  // 三处共用同一条导出判据
  assert.equal(phi.isGovernedClinicalLexemeCandidate("皮损位"), true);
  assert.equal(phi.isGovernedClinicalLexemeCandidate("强中华"), false);
  const source = readFileSync(new URL("../src/lib/phi-sanitizer.ts", import.meta.url), "utf8");
  assert.equal((source.match(/isGovernedClinicalLexemeCandidate\(candidate\)/g) || []).length >= 3, true, "叙述/主语/关系三处都走共享判据");
});

await check("12.1 抬头规则：「高龄男性，既往脑梗死」的高龄不是姓名（17 处，年龄信息送模型前就丢了）；高伟/高寿真姓名照旧脱敏", () => {
  keepAll(["高龄男性，既往脑梗死病史", "高龄女性、既往脑卒中，近日头晕", "高龄70岁，反复咳嗽"], "高龄抬头");
  redactAll(["高伟，男，45岁，头痛3天", "高寿，男，45岁，头痛3天", "高强，女，30岁", "高芳，68岁，咳嗽"], "高姓抬头真名");
  // 浏览器持久化走同一条抬头判据（server 与 browser 不得各写各的）
  assert.equal(persistence.scrubPersistentPhiText("高龄男性，既往脑梗死病史"), "高龄男性，既往脑梗死病史");
  assert.match(persistence.scrubPersistentPhiText("高伟，男，45岁，头痛3天"), /已脱敏/);
  assert.deepEqual(lexemes.headerTerms, ["高龄"], "抬头豁免只放整词「高龄」");
});

await check("13.1 方义起句「方中有人参…」（167 处）：候选「方中」+「有」+ 药名/功效类别/「…之品」才放行；病史句式照旧脱敏", () => {
  keepAll([
    "方中有人参益气，如正在服用人参口服液，请告知医生", "方中有活血化瘀之品，孕妇慎用", "方中有大黄、芒硝，不宜久煎", "方中有肉桂，阴虚火旺者慎用",
    "方中有润肠之品，大便稀溏者酌减", "方中有温补之品，外感发热期间暂停", "方中有孕期慎用的药物，请先确认是否妊娠", "方中有麻黄，高血压者慎用",
    "方中有先煎药物", "方中有清热解毒药，脾胃虚寒者慎用",
  ], "方义起句");
  // 隐私反证：方中 是真实姓名（方 + 中）。有 + 非药名一律脱敏，带人员标签的也脱敏
  redactAll([
    "方中有高血压", "方中有糖尿病史", "方中有大便干结", "方中有过敏史", "患者方中有高血压", "患者方中有服用降压药物史", "家属方中代述病情",
    "本例方中既往有高血压", "方中近日咳嗽", "方中出现胸痛", "方中，男，45岁，头痛3天",
  ], "方中真名");
  assert.equal(lexemes.terms.includes("方中"), false, "「方中」不得进词形闭集（会放出真实姓名）");
  assert.equal(lexemes.formulaReading.candidates.join(), "方中");
  assert.ok(lexemes.formulaReading.openers.includes("人参") && lexemes.formulaReading.openers.includes("活血"));
  assert.ok(!lexemes.formulaReading.objectSuffixes.includes("药物") && !lexemes.formulaReading.objectSuffixes.includes("类药"), "「有服用降压药物史」是病史");
});

await check("14.1 左小腹痛/左侧少腹痛：部位词跨候选边界（小腹被切成「左小」+「腹痛」）；左小真名照旧脱敏", () => {
  keepAll(["左小腹痛3天，伴尿频", "左少腹痛3天，拒按", "左少腹疼痛拒按", "左侧小腹痛7个月，继发不孕", "双侧少腹痛，经行加重", "患者左小腹痛"], "小腹侧别");
  redactAll(["左小出现胸痛", "左小有高血压", "左小近日咳嗽", "左小，男，45岁，头痛", "患者左小诉头痛3天", "左少出现胸痛", "左少有高血压"], "左小/左少真名");
  assert.equal(phi.isStraddledClinicalWord("左小", "腹痛"), true);
  assert.equal(phi.isStraddledClinicalWord("左小", "出现胸痛"), false);
});

await check("15.1 隐私总反证：新词条首字姓 × 常见名字 × 句式，除词条本身外一个都不放出", () => {
  const surnames = [..."查符明尚解关须应连相后耿易常时黎暴宫黄丛经强于曾平水辛郁余左双单高"];
  const given = [..."伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀霞平刚桂英华玲丹萍鹏辉飞鑫波斌宇浩凯健俊阳建亮成佳雪慧婷倩琳颖晶洁梅莉兰凤玉珍春梦云晨文博志海峰东新永生光天德福荣贵国红燕琴发力素中小少和常期"];
  const templates = ["{n}出现胸痛", "{n}有高血压", "反复咳嗽3天，{n}患糖尿病", "患者{n}出现胸痛", "病人{n}有高血压", "家属{n}称患者头痛", "{n}近日咳嗽", "{n}诉头痛3天"];
  // 词形闭集里本来就有的「姓字 + 名字用字」同形词（有意识地豁免，规则见语法源的 basis）；新增词条不得出现在这里
  const preExisting = new Set(["常常", "时常", "经常", "经期", "强中", "平常"]);
  const terms = new Set(lexemes.terms);
  let checked = 0;
  for (const s of surnames) for (const g of given) {
    const name = s + g;
    if (terms.has(name)) { assert.ok(preExisting.has(name), `新增词条 ${name} 与「姓 + 常见名字用字」同形，会放出真实姓名`); continue; }
    for (const template of templates) {
      const text = template.replace("{n}", name);
      assert.ok(!scrub(text).includes(name), `姓名泄漏：${text} → ${scrub(text)}`);
      checked += 1;
    }
  }
  assert.ok(checked > 15000, `只检了 ${checked}`);
});

await check("15.2 隐私反证（词条 + 一个名字用字 = 三字姓名）：新增两字词条后接常见名字用字，仍须脱敏", () => {
  const twoCharNew = ["查体", "查看", "符合", "明确", "解释", "关注", "须辨", "尚缺", "尚无", "尚未", "应当", "应置", "连声", "相比", "耿耿", "易与", "易混", "常不", "常因", "宫口", "黄涕", "经筋", "强痉", "暴食", "暴饮"];
  const tails = [..."华明伟强芳丽军敏静磊杰涛秀英玲平红玉梅兰凤燕琴建国志文海东生光天德福荣"];
  const terms = new Set(lexemes.terms);
  for (const head of twoCharNew) {
    assert.ok(terms.has(head), `${head} 应在词形闭集`);
    for (const tail of tails) {
      const name = head + tail;
      for (const template of ["{n}出现胸痛", "{n}有高血压", "患者{n}近日咳嗽"]) {
        const text = template.replace("{n}", name);
        assert.ok(!scrub(text).includes(name), `三字姓名泄漏：${text} → ${scrub(text)}`);
      }
    }
  }
});

await check("15.3 既有闭集与既有隐私对照不受影响（平素/常发/劳力/暴发/卫阳/后天仍不收）", () => {
  const terms = new Set(lexemes.terms);
  for (const word of ["平素", "常发", "时发", "劳力", "暴发", "卫阳", "后天", "黎明", "方中", "左小", "左少", "高寿", "养成", "毛发"]) {
    assert.equal(terms.has(word), false, `${word} 与姓名同形，不得进词形闭集`);
  }
  redactAll(["平素芬出现胸痛", "常发出现胸痛", "劳力患糖尿病", "暴发有高血压", "卫阳头痛3天", "后天近日咳嗽"], "既有隐私对照");
});

console.log(JSON.stringify({ suite: "r1022-phi", cases, failures: process.exitCode ? "see above" : 0 }));
