// 10/19 第四轮（2026-10-19）：模块验收集 M（360 例）改由 Claude 评审员逐例评审后，报出的服务端文本缺陷，一类一修。
//
// 每条断言都带反证：把改动撤掉或换成对照输入后必须变红（反证记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt）。
//
//   1 脉象：叙述式写法（「左手脉象弦硬」「脉搏跳动微弱」「诊查显示脉象浮滑有力」「脉平和」）算已记录脉象；
//     「诊脉弦数与否」「未诉…脉微欲绝之危象」这类核实/缺如小句不改写（M 集 27 例辨证依据成了「脉象待核实绷有力」）
//   2 方义：删外来药后改写味数时不碰「五味子」
//   3 注意事项里的在用药：药名候选清理（「控制」「依折麦布片一天」「α骨化醇片(」…）、商品名里的「和」、后来停了或只在「曾…」里的药、
//     「不规律服用」不写成停药（M 集注意事项一栏 16 例）
//   4 子宫已切除、已绝经的病人不再写「如已怀孕、可能怀孕或正在哺乳」（M 集 6 例）
//   6 门禁：神经急症理由按实际命中项写（没有头痛的不写「突发剧烈头痛」）；千帕血压换算（「BP21/12kPa」报了休克）
//   7 教材行不跨病借用：病名在表里没有节时，同名证属于别的病（鼻渊→黄疸、面痛→血证），不锚定
//   8 脱敏：「平素入睡」不当平姓人名（受治理构词表 habitual_sleep_onset）
//   9 治则：「固冲/固摄/生津/敛汗」只在证名有虚时算补法
//   10 治法里重复的短语（字全在另一个短语里）只留一个
//   11 西医鉴别「A/B」拆出只剩部位或走向的碎片时整行不拆
//   12 登记年龄缺失、病历别处称「患儿」：按儿童、年龄段判不出时收回剂量
//   13 育龄女性本次月经逾期未至：注意事项写先验孕
//   14 「妊娠8个月」「怀孕六个月」「孕七月」判妊娠（此前「个月」与中文数字都认不出）
//   5 「无X→未诉X」只改对本例的否认（固定说法、别的病的描述、核实句、检验与检查所见、医学术语；「未诉A；未诉B」并句）
//   6 门禁另：血压范围写法按一次读数取上限；有本次体温时不以前几天/上次的极值报红旗
//   14 另：「还能哺乳吗」「能不能喂奶」按可能哺乳
//   15 饮食段：与煎服法相反的服药时间、方中有毒药当食物推荐去掉；外用药不写服用与同服间隔
//   16 第五轮：「无…史」对「不…」、对象截到「示」、检查描述的缺如不改、「风药」不是药名：固定说法、别的病的描述、核实句、检验项不改；列举逐项去「无」不动「无力」（H 集十余处）

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
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const clinicalState = await jiti.import("../src/lib/clinical-state.ts");

const stateOf = (presentHistory, { safetyGate, patient, ...extra } = {}) => {
  const normalized = types.normalizeCaseStateInput({
    id: "r4", chiefComplaint: "x", patient: patient || { sex: "女", age: 28 }, symptoms: { presentHistory }, conversation: [], ...extra,
  });
  return safetyGate ? { ...normalized, safetyGate } : normalized;
};
const sanitizeOverview = (record, overview) => {
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", overview })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = safety.sanitizeUngroundedRedFlagNegations(content, stateOf(record));
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).overview;
};

// ───── 1 脉象 ─────
await check("1.1 叙述式脉象算已记录：辨证依据里据此写的脉象原样保留；同一句换到没有脉象的病历上照旧改写（对照）", () => {
  const rationale = "胁肋胀痛、嗳气，左手脉弦硬主气滞，右手脉细软主气血不足。";
  for (const record of [
    "胁肋胀痛半年，嗳气频作。左手脉象弦硬，右手脉象细软。",
    "胁肋胀痛半年，诊查显示脉象浮滑有力。",
    "胁肋胀痛半年，把脉时发现双手脉搏细而紧绷。",
    "胁肋胀痛半年，脉搏跳动微弱。",
    "胁肋胀痛半年，舌淡红，脉平和。",
    "胁肋胀痛半年，按压到尺脉时完全摸不到脉动。",
  ]) {
    assert.equal(sanitizeOverview(record, { tcmDiagnosticRationale: rationale }).tcmDiagnosticRationale, rationale, record);
  }
  assert.match(sanitizeOverview("胁肋胀痛半年，嗳气频作。", { tcmDiagnosticRationale: rationale }).tcmDiagnosticRationale, /脉象待核实/);
});

await check("1.2 生命体征与血管名不算脉象：「脉搏80次/分」「脉搏跳动频率为每分钟约75次」「静脉曲张」「舌下脉络迂曲」", () => {
  for (const text of ["脉搏80次/分，血压120/80mmHg", "脉搏跳动频率为每分钟约75次", "双下肢静脉曲张", "舌下脉络迂曲", "脉象未查"]) {
    assert.equal(clinicalState.isUnknownClinicalFieldText(text, "pulse"), true, text);
  }
  for (const text of ["左手脉象弦硬", "六脉微弱沉细但脉率正常", "所有脉搏都无法触及", "脉象左沉弦数", "左脉右脉均呈现弦脉"]) {
    assert.equal(clinicalState.isUnknownClinicalFieldText(text, "pulse"), false, text);
  }
});

await check("1.3 病历没有脉象时，「诊脉弦数与否」「未诉肢冷、脉微欲绝之危象」「…脉微欲绝，本例未诉此」不改写；对本例的断言照旧改写（对照）", () => {
  const record = "反复心悸2月，活动后加重，夜寐欠安。";
  const kept = sanitizeOverview(record, {
    tcmDiagnosticRationale: "心悸、寐差，属心血不足；脉细数，示阴血亏虚。",
    mustCollect: ["望舌质舌苔、诊脉弦数与否"],
    tcmDiseaseDifferentials: [{ diseaseName: "脱汗", distinguishingPoints: "脱汗见于危重、汗出如珠伴肢冷脉微欲绝，本例未诉此；本例未诉肢冷息短、脉微欲绝之危象" }],
  });
  assert.equal(kept.mustCollect[0], "望舌质舌苔、诊脉弦数与否");
  assert.equal(kept.tcmDiseaseDifferentials[0].distinguishingPoints, "脱汗见于危重、汗出如珠伴肢冷脉微欲绝，本例未诉此；本例未诉肢冷息短、脉微欲绝之危象");
  assert.match(kept.tcmDiagnosticRationale, /脉象待核实/);
  assert.doesNotMatch(kept.tcmDiagnosticRationale, /脉细数/);
  // 舌象先换成「舌象待核实」后，同一小句里编出的脉象照样改写（不因「核实」二字放过）。
  const both = sanitizeOverview(record, { tcmDiagnosticRationale: "多食易饥、口渴，舌红苔黄脉滑实，属胃热。" }).tcmDiagnosticRationale;
  assert.doesNotMatch(both, /脉滑实/u, both);
});

// ───── 2 方义文字 ─────
await check("2.1 删外来药后按剩下的本方药味数改写「二药/三味」，不把「五味子」的「五味」当味数（M 集 0486「二味子」）；真正的「三味」照旧改写（对照）", async () => {
  const review = await jiti.import("../src/lib/formula-analysis-review.ts");
  const herbs = ["菟丝子", "桑螵蛸", "肉苁蓉", "山茱萸", "牡蛎", "五味子", "茯神", "石菖蒲"];
  const text = "本方以桑螵蛸散为基础加减。菟丝子、桑螵蛸为君，补肾固精缩尿；肉苁蓉、山茱萸为臣，温肾益精；龙骨、牡蛎、五味子为佐，收敛固涩；茯神、石菖蒲为使，宁心安神、交通心肾。";
  const result = review.reviewAuthoredFormulaAnalysis(text, herbs);
  assert.match(result.text, /牡蛎、五味子为佐/);
  assert.doesNotMatch(result.text, /二味子|龙骨/);
  const counted = review.reviewAuthoredFormulaAnalysis("本方以桑螵蛸散为基础加减。菟丝子、桑螵蛸为君，补肾固精缩尿；肉苁蓉、山茱萸为臣，温肾益精；龙骨、牡蛎、五味子三味为佐，收敛固涩；茯神、石菖蒲为使，宁心安神。", herbs);
  assert.match(counted.text, /牡蛎、五味子二味为佐/);
});

// ───── 3 注意事项：病历里的用药 ─────
const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
const precautions = await jiti.import("../src/lib/required-precautions.server.ts");
const medicationItems = (record, extra = {}) => precautions.requiredPrecautionsForCase(stateOf(record, extra)).filter((item) => /medication/.test(item.kind));
const currentNames = (record) => medicationItems(record).find((item) => item.kind === "current_medications")?.names || [];

await check("3.1 药名候选的构词式清理：用量、括注、用途短语处截断，引导词与用法缩写去掉，时间量词、类别说法、治疗方式不算药名", () => {
  const cases = {
    "依折麦布片一天": "依折麦布片", "α骨化醇片(": "α骨化醇片", "西替利嗪片抗过敏)": "西替利嗪片", "包括甲泼尼龙": "甲泼尼龙",
    "qd+缬沙坦": "缬沙坦", "二甲双胍早": "二甲双胍", "安罗替尼抗血管生成": "安罗替尼", "科素亚控制血压": "科素亚", "硝酸甘油可缓解": "硝酸甘油",
    "降糖药二甲双胍": "二甲双胍", "维生素B6": "维生素B6", "止咳糖浆": "止咳糖浆",
    "控制": "", "数月": "", "bid抑制免疫": "", "保肝降酶": "", "靶向药物出现血压升高": "", "频发房性早搏": "", "通络止痛类中成药": "", "外敷药膏": "", "降压药物": "",
  };
  for (const [raw, expected] of Object.entries(cases)) assert.equal(polarity.cleanedMedicationNameCandidate(raw), expected, raw);
});

await check("3.2 在用药一项不再列「控制」「依折麦布片一天」；只写「服用西药控制」的按没写药名处理；引号里整串列举拆成各个药（M 集 0512、MTCMB-81、TCM-SD-432116）", () => {
  const unnamed = medicationItems("高血压病史10年，长期服用西药控制，就诊时血压维持在120~130/70 mmHg。");
  assert.ok(!unnamed.some((item) => item.kind === "current_medications"), JSON.stringify(unnamed));
  assert.ok(unnamed.some((item) => item.kind === "unnamed_medication"), JSON.stringify(unnamed));
  assert.deepEqual(currentNames("现规律服用依折麦布片一天1次，一次1片，阿司匹林100mg qd，可定5mg qn。").slice(0, 3), ["依折麦布片", "阿司匹林", "可定"]);
  assert.deepEqual(currentNames("诊断为冠心病。平素服用“拜阿司匹林、倍他乐克缓释片、盐酸二甲双胍”等药物。昨夜胸闷加重。"), ["拜阿司匹林", "倍他乐克缓释片", "盐酸二甲双胍"]);
});

await check("3.3 商品名里的「和」不是连词：诺和龙、诺和锐照样取到；「加用」也是给药（M 集 TCMChat-495、TCM-SD-447858）；真正的「A和B」照旧拆开（对照）", () => {
  assert.deepEqual(currentNames("10年前开始服用药物，一直口服诺和龙0.5mg tid治疗，后加用来得时13u iH 一日一次，血糖既往控制尚可。"), ["诺和龙", "来得时"]);
  assert.deepEqual(currentNames("现皮下注射诺和锐，早16U，晚12U，自测空腹血糖8-10mmol/l。"), ["诺和锐"]);
  assert.deepEqual(polarity.splitMedicationList("阿司匹林和氯吡格雷"), ["阿司匹林", "氯吡格雷"]);
});

await check("3.4 后来停了、或只在「曾…」里出现的药不算在用（M 集 TCMChat-418 安罗替尼、0532 α骨化醇）；写着在用的照旧列（对照）", () => {
  const stopped = "一直口服安罗替尼抗血管生成治疗，2020年3月复查胸部CT病灶略缩小，遂予洛铂化疗1周期，后患者因持续血小板、白细胞降低停用安罗替尼，后未再接受抗肿瘤治疗。";
  assert.deepEqual(currentNames(stopped), []);
  assert.deepEqual(currentNames("一直口服安罗替尼抗血管生成治疗，至今未停用。"), ["安罗替尼"]);
  assert.deepEqual(currentNames("经输液治疗后症状缓解。既往曾接受醋酸泼尼松（8 片/次，隔日一次，口服）及α骨化醇片（1 片/次，1 次/日）治疗。"), []);
  assert.deepEqual(currentNames("现口服α骨化醇片（1 片/次，1 次/日）。"), ["α骨化醇片"]);
});

await check("3.5 「不规律服用」不是自行停药：写成未规律服用；引号里的诊断（「频发房性早搏」）不当药名（M 集 MTCMB-87）", () => {
  const items = medicationItems("诊断为“频发房性早搏”，收入住院治疗，好转后出院，出院后上述症状每遇劳累易发，不规律服用“稳心颗粒”，效可。");
  const discontinued = items.find((item) => item.kind === "self_discontinued_medication");
  assert.ok(discontinued?.irregular, JSON.stringify(items));
  assert.ok(!discontinued.names.includes("频发房性早搏"), JSON.stringify(discontinued));
  const surfaceModule = jiti.import("../src/lib/delivered-surface.ts");
  return surfaceModule.then(() => {
    const stoppedItems = medicationItems("高血压病史8年，1个月前自行停用降压药。");
    assert.ok(!stoppedItems.find((item) => item.kind === "self_discontinued_medication")?.irregular, JSON.stringify(stoppedItems));
  });
});

// ───── 4 妊娠哺乳一条只给可能怀孕的人 ─────
await check("4.1 子宫已切除、病历写「已绝经/月经已绝」、50 岁以上「已停经」：不再要求妊娠筛查、不写妊娠哺乳一条；子宫肌瘤剔除、未绝经、45 岁「已停经」照旧（对照）", () => {
  const relevant = (record, age) => safety.reproductiveAdviceRelevant(stateOf(record, { patient: { sex: "女", age } }));
  for (const [record, age] of [
    ["22年前因子宫肌瘤行子宫切除术，术后恢复良好。", 45],
    ["2020-07-29在全麻下行腹腔镜下广泛子宫加双附件切除加盆腔淋巴结清扫术。", 45],
    ["适龄婚育，育有1女；现已绝经。", 48],
    ["素体虚弱，月经已绝。", 52],
    ["适龄婚育，育有1子；已停经，无异常阴道流血。", 57],
  ]) assert.equal(relevant(record, age), false, record);
  for (const [record, age] of [
    ["3年前行子宫肌瘤切除术，术后月经规律。", 38],
    ["未绝经，月经周期规律。", 48],
    ["末次月经2月前，现已停经。", 45],
    ["围绝经期，月经紊乱。", 49],
  ]) assert.equal(relevant(record, age), true, record);
});

// ───── 5 「无X」改「未诉X」只改对本例的否认 ─────
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
await check("5.1 固定说法、别的病的描述、核实句、检验项里的「无」不改「未诉」（H 集「痛未诉休止」「乳汁未诉由而生」「肠结…未诉矢气」「有无未诉热发作」）；对本例的否认照旧改（对照）", () => {
  const record = "头身困重3日，胃脘不适。";
  const kept = [
    "以头痛如裹、痛无休止为主症", "气血生化乏源，乳汁无由而生", "干呕有声无物", "发色枯槁无光泽", "肿瘤多呈进行性无痛性黄疸",
    "肠结以腹痛拒按、大便完全不通且无矢气为主", "口僻仅口眼歪斜而无半身不遂", "痿证以肢体痿弱不用、一般无痛为主", "肝脓肿多无波动性黄疸",
    "无矢气之肠结", "核实：无呕吐", "既往有无无热发作未提供", "急性闭角型青光眼（无眼压资料）",
  ];
  for (const text of kept) assert.equal(visible.unrecordedNegativesAsNotReported(text, record), text, text);
  assert.equal(visible.unrecordedNegativesAsNotReported("本例局部无灼热红肿", record), "本例局部未诉灼热红肿");
  assert.equal(visible.unrecordedNegativesAsNotReported("胃脘不适，无反酸", record), "胃脘不适，未诉反酸");
  assert.equal(visible.unrecordedNegativesAsNotReported("不支持：未提供血常规结果、无面色苍白", record), "不支持：未提供血常规结果、未诉面色苍白");
});

await check("5.2 鉴别行列举里逐项去「无」时不动「无力」（H 集 X-H-0230「未诉上肢麻木、力或感觉异常」）；「、无头晕」照旧去（对照）", () => {
  const ground = (points) => {
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", overview: { tcmDiseaseDifferentials: [{ diseaseName: "痹证", distinguishingPoints: points }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
    const out = visible.groundDifferentialNegativeAssertions(content, "右肩痛2周，向上臂放射。");
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).overview.tcmDiseaseDifferentials[0].distinguishingPoints;
  };
  const weak = ground("本例仅肩部放射痛，无上肢麻木、无力或感觉异常");
  assert.doesNotMatch(weak, /、力/u, weak);
  assert.match(weak, /无力/u, weak);
  assert.doesNotMatch(ground("无上肢麻木、无头晕"), /、无头晕/u);
});

await check("5.3 已是「未诉」的不再叠成「未诉未诉」（H 集 X-H-0312、0115）", () => {
  assert.equal(visible.unrecordedNegativesAsNotReported("本例未诉未诉矢气", "便秘3天。"), "本例未诉矢气");
});

// ───── 6 门禁：神经急症理由按实际命中项写；千帕血压换算 ─────
const gateOf = (record, extra = {}) => safety.withSafetyGate(stateOf(record, extra)).safetyGate;
await check("6.1 只有神经功能缺损、没有头痛的病历，不给剂量的理由不写「突发剧烈头痛」（H 集十余例）；突发剧烈头痛照旧写（对照）", () => {
  const deficit = gateOf("今晨突然出现右侧肢体无力、言语不清，持续2小时。");
  assert.equal(deficit.status, "red_flag");
  assert.ok(deficit.redFlags.some((flag) => /^意识或神经功能异常，需优先排除神经系统急症/u.test(flag)), deficit.redFlags.join("|"));
  assert.ok(!deficit.redFlags.some((flag) => /剧烈头痛/u.test(flag)), deficit.redFlags.join("|"));
  const headache = gateOf("今晨用力排便时突发剧烈头痛，为平生最剧烈的头痛。");
  assert.ok(headache.redFlags.some((flag) => /^突发剧烈头痛/u.test(flag)), headache.redFlags.join("|"));
});

await check("6.2 千帕写的血压按 7.5 换算（H 集 H-tri-2808「BP21/12kPa」被当成 21/12mmHg 报休克）；真正的低血压照旧报（对照）", () => {
  const kpa = gateOf("头晕1周。查体：T36.5℃，P78次/分，BP21/12kPa。");
  assert.ok(!kpa.redFlags.some((flag) => /低血压|休克/u.test(flag)), kpa.redFlags.join("|"));
  const decimal = gateOf("头晕1周。查体：血压 16.0/10.7kPa。");
  assert.ok(!decimal.redFlags.some((flag) => /低血压|休克/u.test(flag)), decimal.redFlags.join("|"));
  const shock = gateOf("头晕1周。查体：BP 70/40mmHg，面色苍白，四肢湿冷。");
  assert.ok(shock.redFlags.some((flag) => /低血压|休克/u.test(flag)), shock.redFlags.join("|"));
});

// ───── 7 教材行不跨病借用 ─────
await check("7.1 教材表里没有这个病的节时，不按证名借别的病的行（H 集 鼻渊→黄疸、面痛→血证/中风、耳鸣→血证）；国标同一个病的别名照旧找回（头风病→头痛，对照）", async () => {
  const tb = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
  for (const [disease, syndrome] of [["鼻渊", "胆腑郁热证"], ["面痛", "风痰阻络证"], ["面痛", "胃火炽盛证"]]) {
    assert.equal(tb.textbookRowForSyndrome(disease, syndrome), undefined, `${disease}·${syndrome}`);
  }
  assert.equal(tb.textbookRowForSyndrome("头风病", "瘀血头痛证")?.disease, "头痛");
});

// ───── 8 脱敏不抹「平素入睡」 ─────
await check("8.1 「平素入睡困难」不被当成平姓人名抹掉（H 集 H-tri-19642「[已脱敏]睡困难」）；真实姓名照旧脱敏（对照）", () => {
  assert.equal(safety.sanitizeFreeTextForModel("睡眠不佳时诱发。平素入睡困难，多梦"), "睡眠不佳时诱发。平素入睡困难，多梦");
  assert.equal(safety.sanitizeFreeTextForModel("患者平素入睡困难"), "患者平素入睡困难");
  assert.match(safety.sanitizeFreeTextForModel("患者张平素入睡困难"), /已脱敏/u);
  assert.match(safety.sanitizeFreeTextForModel("。张小明入睡困难"), /已脱敏/u);
});

// ───── 9 治则：实证里的「固冲止血」不算补法 ─────
await check("9.1 血热证·清热凉血、固冲止血 推不出「扶正祛邪」（H 集 X-H-0338）；脾不统血·健脾益气、固冲止血 仍是补（对照）", () => {
  const principle = (primarySyndrome, overallMethod) => visible.nationalTreatmentPrinciple("扶正祛邪", { overview: { primarySyndrome }, therapy: { overallMethod } });
  assert.notEqual(principle("血热证", "清热凉血，固冲止血"), "扶正祛邪");
  assert.equal(principle("气虚证", "补气摄血，固冲止血"), "虚则补之");
});

// ───── 10 治法里重复的短语只留一个 ─────
await check("10.1 「清利湿热，清热利湿」「…和胃化湿…化湿和胃」「息风化痰…熄风化痰止痛」去重（M/H 集）；意思相近用字不同的不动（对照）", async () => {
  const surfaceModule = await jiti.import("../src/lib/delivered-surface.ts");
  const method = (overallMethod) => surfaceModule.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: {}, therapy: { overallMethod } }).therapy.overallMethod;
  assert.equal(method("清利湿热，清热利湿"), "清利湿热");
  assert.equal(method("平肝潜阳，和胃化湿，通络止痛，化湿和胃"), "平肝潜阳，和胃化湿，通络止痛");
  assert.equal(method("息风化痰，活血通络，熄风化痰止痛"), "活血通络，熄风化痰止痛");
  assert.equal(method("养血和络，益气养血"), "养血和络，益气养血");
  assert.equal(method("健脾助运，健脾益气"), "健脾助运，健脾益气");
});

// ───── 11 西医鉴别拆分不留碎片 ─────
await check("11.1 拆出来只剩部位或走向的（「食管/胃恶性肿瘤」「脑膜瘤术后复发/残余」「酒精滥用/依赖」）整行不拆；借得到的照旧拆（「腰椎感染/结核」「膈肌/胸部病变」，对照）", () => {
  const wrap = (reasoning) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const unwrap = (content) => JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
  const split = (name) => unwrap(visible.groundStructuredPatientFacts(wrap({
    stage: "diagnose",
    westernDiagnosis: { primary: { name: "腰痛", supportingFacts: [] }, differentials: [{ name, reason: "需排除", distinguishingPoints: "需影像评估", nextCheck: "影像检查" }] },
    pathogenesis: { chain: [] },
  }), "主诉：腰痛3个月")).westernDiagnosis.differentials.map((item) => item.name);
  for (const name of ["食管/胃恶性肿瘤", "脑膜瘤术后复发/残余", "酒精滥用/依赖"]) {
    const parts = split(name);
    assert.ok(!parts.some((part) => /^(?:食管|残余|依赖)$/u.test(part)), `${name} → ${parts.join("|")}`);
  }
  assert.deepEqual(split("腰椎感染/结核"), ["腰椎感染、腰椎结核"]);
  assert.deepEqual(split("膈肌/胸部病变"), ["膈肌病变、胸部病变"]);
});

// ───── 12 没有登记年龄、病历称「患儿」的按儿童收回剂量 ─────
await check("12.1 登记年龄空、病历「患者张某，男，年龄未详（文中称患儿）」：收回剂量、追问年龄（H 集 H-tri-289 按成人给了人参 6g）；成人病历照常（对照）", () => {
  const child = safety.withSafetyGate(stateOf("患者张某，男，年龄未详（文中称患儿）。2月前因高烧诊断为肺炎，退热后发现双目失明。", { patient: { sex: "男", age: "" } }));
  assert.equal(safety.derivePrescriptionPermission(child).candidateMode, "non_dose_only");
  const adult = safety.withSafetyGate(stateOf("患者张某，男，年龄未详。2月前因高烧诊断为肺炎，退热后视物模糊。", { patient: { sex: "男", age: "" } }));
  assert.notEqual(safety.derivePrescriptionPermission(adult).candidateMode, "non_dose_only");
});

// ───── 13 本次月经逾期未至：先验孕 ─────
await check("13.1 育龄女性「末次月经10月21日，至今未至」：注意事项一项是先验孕（M 集 RobustSDT-0697）；没写逾期的仍是一般的妊娠哺乳一项（对照）", () => {
  const kinds = (record) => precautions.requiredPrecautionsForCase(stateOf(record, { patient: { sex: "女", age: 39 } })).map((item) => item.kind);
  assert.ok(kinds("月经周期紊乱，表现为周期延迟，末次月经为10月21日，至今未至；经前伴有胸胀。").includes("menses_overdue_pregnancy_check"));
  const plain = kinds("月经周期规律，末次月经10月21日。");
  assert.ok(plain.includes("reproductive_status_unknown") && !plain.includes("menses_overdue_pregnancy_check"), plain.join("|"));
  assert.ok(!kinds("否认月经推迟，末次月经10月21日。").includes("menses_overdue_pregnancy_check"));
});

// ───── 14 「妊娠8个月」「怀孕六个月」是妊娠 ─────
await check("14.1 「妊娠8个月」「怀孕六个月」「孕七月」判妊娠、收回剂量（A 集 A-non-0023 给了剂量）；孕产史与不孕照旧（对照）", () => {
  for (const text of ["妊娠8个月，心悸1周", "怀孕六个月的妇女，高热不退", "孕七月，下肢浮肿"]) assert.equal(clinicalState.assessPregnancyState(text).status, "positive", text);
  assert.equal(clinicalState.assessPregnancyState("孕1产1").status, "historical");
  assert.equal(clinicalState.assessPregnancyState("不孕3年").status, "unknown");
  const pregnant = safety.withSafetyGate(stateOf("妊娠8个月，近1周心悸、怕热、多汗，甲状腺功能T3、T4正常。", { patient: { sex: "女", age: 28 } }));
  assert.equal(safety.derivePrescriptionPermission(pregnant).candidateMode, "non_dose_only");
});

await check("5.4 医学术语与检查所见里的「无」不改（D 集「未诉菌性脓尿」「未诉相关P波」「冠脉造影未诉阻塞性病变」「未诉典型辐射状血管网」）", () => {
  const record = "心悸1周。皮肤可见红斑，呈辐射状血管网。";
  for (const text of ["结核多为慢性迁延伴无菌性脓尿", "与典型无排卵不符", "心电图其前无相关P波", "冠脉造影无阻塞性病变", "无典型辐射状血管网"]) {
    assert.equal(visible.unrecordedNegativesAsNotReported(text, record), text, text);
  }
  assert.equal(visible.unrecordedNegativesAsNotReported("本例无发热", record), "本例未诉发热");
});

await check("5.5 交付面把「未诉A；未诉B；未诉C」并成「未诉A、B、C」", async () => {
  const surfaceModule = await jiti.import("../src/lib/delivered-surface.ts");
  assert.equal(surfaceModule.clinicalWordingForSyntheticPhrases("病历尚未确认咯血是否存在；病历尚未确认消瘦是否存在；病历尚未确认盗汗是否存在"), "未诉咯血、消瘦、盗汗");
});

await check("5.6 病历记有神经系统检查、两肺听诊时，鉴别里的查体断言不再改成「本次病历未记录…查体结果」（D 集 X-D-1065、2721）；病历没有时照旧改（对照）", () => {
  const exam = (record, text) => sanitizeOverview(record, { tcmDiagnosticRationale: text }).tcmDiagnosticRationale;
  assert.equal(exam("面部阵发性剧痛1年。神经系统未见明显阳性体征。", "神经系统查体未见阳性体征，非中风"), "神经系统查体未见阳性体征，非中风");
  assert.equal(exam("咳嗽2周。两肺未闻干、湿啰音。", "两肺未闻及啰音，非肺痈"), "两肺未闻及啰音，非肺痈");
  assert.match(exam("咳嗽2周。", "两肺未闻及啰音，非肺痈"), /本次病历未记录肺部听诊结果/);
});

await check("6.3 血压范围写法「180～200/100～110mmHg」「140～159/90～99」按一次读数取上限，不报「收缩压/舒张压倒置」（D 集 X-D-0395、1223）", () => {
  for (const record of ["高血压10年，平素血压180～200/100～110mmHg，头晕1周。", "高血压病史，血压波动于140～159/90～99mmHg。"]) {
    const gate = gateOf(record);
    assert.ok(!gate.redFlags.some((flag) => /倒置/u.test(flag)), `${record} → ${gate.redFlags.join("|")}`);
  }
});

await check("6.4 有本次体温时以本次为准，「前几天发烧39-40℃，现在快39℃」「12月流感时体温40℃」不报极高热（B 集）；只有那次读数或本次 40℃ 照旧报（对照）", () => {
  const child = { patient: { sex: "男", age: 4 } };
  assert.ok(!gateOf("前几天发烧39-40℃，现在快39℃，精神好。", child).redFlags.some((flag) => /极高热/u.test(flag)));
  assert.ok(!gateOf("12月流感时体温40℃，现在咳嗽。", child).redFlags.some((flag) => /极高热/u.test(flag)));
  assert.ok(gateOf("前几天发烧39-40℃。", child).redFlags.some((flag) => /极高热/u.test(flag)));
  assert.ok(gateOf("发热2天，今日体温40.5℃。", child).redFlags.some((flag) => /极高热/u.test(flag)));
});

await check("14.2 「妈妈拉肚子还能哺乳吗」「能不能喂奶」按可能哺乳（B 集 MedDG-164#3）", () => {
  assert.equal(clinicalState.assessLactationState("妈妈拉肚子还能哺乳吗").status, "possible");
  assert.equal(clinicalState.assessLactationState("吃了头孢能不能喂奶").status, "possible");
  assert.equal(clinicalState.assessLactationState("否认哺乳").status, "negative");
});

await check("5.7 「无从判定」「无热惊厥」不改「未诉」（D 集）；「无发热」照旧改（对照）", () => {
  assert.equal(visible.unrecordedNegativesAsNotReported("虚实寒热无从判定", "腹痛1天。"), "虚实寒热无从判定");
  assert.equal(visible.unrecordedNegativesAsNotReported("少见无热反复发作", "抽搐1次。"), "少见无热反复发作");
  assert.equal(visible.unrecordedNegativesAsNotReported("本例无发热", "抽搐1次。"), "本例未诉发热");
});

await check("1.4 「…无发热，本例持续高热不符」里的「无发热」说的是鉴别对象，不改成「有发热」（D/H 集）；对本例自己的否认照旧改（对照）", () => {
  const record = "高热3天，体温39.5℃，抽搐1次。";
  const kept = sanitizeOverview(record, { tcmDiseaseRationale: "痫证发作时无发热，本例持续高热不符" }).tcmDiseaseRationale;
  assert.equal(kept, "痫证发作时无发热，本例持续高热不符");
  const own = sanitizeOverview(record, { tcmDiseaseRationale: "本例无发热，故非外感" }).tcmDiseaseRationale;
  assert.doesNotMatch(own, /本例无发热/u);
});

// ───── 15 饮食段与外用药措辞 ─────
await check("15.1 饮食段里与煎服法相反的服药时间、把方中有毒药当食物推荐的小句去掉（M 集 TCM-SD-422604「饭前温服汤药」对饭后；466542「食用桃仁煮粥」而方中有桃仁）；别的饮食建议照留（对照）", async () => {
  const surfaceModule = await jiti.import("../src/lib/delivered-surface.ts");
  const projected = surfaceModule.projectDeliveredReasoning({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "血府逐瘀汤加减", herbs: [{ name: "桃仁", dose: "10g" }, { name: "红花", dose: "6g" }, { name: "当归", dose: "10g" }], decoction: { method: "水煎服，每日1剂，分2次饭后温服。" } }] },
    nonPharma: { diet: "饭前温服汤药，饮食清淡；可适量食用桃仁煮粥，多吃新鲜蔬菜。", precautions: [] },
  });
  const diet = projected.nonPharma.diet;
  assert.doesNotMatch(diet, /饭前温服/u, diet);
  assert.doesNotMatch(diet, /桃仁/u, diet);
  assert.match(diet, /新鲜蔬菜/u, diet);
});

await check("15.2 外用药（红花油、奇正消痛贴）的注意事项不写「服用」「同服间隔」（H 集 2210、6369）", async () => {
  const surfaceModule = await jiti.import("../src/lib/delivered-surface.ts");
  const projected = surfaceModule.projectDeliveredReasoning({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "独活寄生汤加减", herbs: [{ name: "独活", dose: "10g" }], decoction: { method: "水煎服，每日1剂，分2次饭后温服。" } }] },
    nonPharma: { diet: "饮食清淡。", precautions: ["饭后温服，忌生冷。"] },
  }, { requiredPrecautions: [
    { kind: "self_medication", name: "红花油", base: "红花油", composition: [], alcoholWarning: false },
    { kind: "current_medications", names: ["奇正消痛贴"] },
  ] });
  const lines = projected.nonPharma.precautions.join("|");
  assert.match(lines, /已外用的红花油/u, lines);
  assert.match(lines, /正在外用的奇正消痛贴/u, lines);
  assert.doesNotMatch(lines, /红花油是否继续服用|奇正消痛贴请告知医生，是否继续服用/u, lines);
});

await check("15.3 注意事项禁一类药的几种写法（「勿与同类清热化痰中成药叠加」「避免与理气类中成药重复使用」「不宜再服润肠通便类中成药」）与推荐药同类时不留（M 集 RobustSDT-0154、TCM-SD-482303）；推荐里没有这一类时照留（对照）", async () => {
  const surfaceModule = await jiti.import("../src/lib/delivered-surface.ts");
  const out = (line, recommend) => surfaceModule.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
    formula: { candidates: [{ name: "清金化痰汤加减", herbs: [], decoction: { method: "分2次饭后温服" } }], patentAndWestern: recommend },
    nonPharma: { precautions: [line, "注意休息。"], acupointCare: null, tcmTreatments: [] } }).nonPharma.precautions;
  assert.deepEqual(out("服药期间勿与同类清热化痰中成药叠加。", [{ name: "清气化痰丸", correspondingProblem: "痰热咳嗽", indication: "清热化痰，止咳" }]), ["注意休息。"]);
  assert.deepEqual(out("避免与理气类中成药重复使用。", [{ name: "舒肝丸", correspondingProblem: "胁痛", indication: "舒肝和胃，理气止痛" }]), ["注意休息。"]);
  assert.deepEqual(out("服药期间勿与同类清热化痰中成药叠加。", [{ name: "复方丹参滴丸", correspondingProblem: "胸痹" }]), ["服药期间勿与同类清热化痰中成药叠加。", "注意休息。"]);
});

// ───── 16 第五轮（21b9bef 上甲方 10 例三轮与留出 32 例复评） ─────
await check("16.1 病历写「不吸烟」时鉴别里的「无吸烟史」不改成「病历未记录吸烟史」（甲方病历 5）；病历没写吸烟的照改（对照）", () => {
  const ground = (record, points) => {
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", westernDiagnosis: { primary: { name: "反复感冒" }, differentials: [{ name: "慢性阻塞性肺疾病", reason: "需排除", distinguishingPoints: points, nextCheck: "肺功能" }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
    const out = visible.groundDifferentialNegativeAssertions(content, record);
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).westernDiagnosis.differentials[0].distinguishingPoints;
  };
  assert.equal(ground("反复感冒1年。个人史：不吸烟，不饮酒。", "无吸烟史"), "无吸烟史");
  assert.match(ground("反复感冒1年。", "无吸烟史"), /病历未记录吸烟史/u);
});

await check("16.2 「无腹痛腹泻示…」对象截到「示」为止（甲方病历 9：整段推断被当成对象，病历里找不到，改成了「未诉腹痛腹泻示…」）", () => {
  assert.equal(visible.unrecordedNegativesAsNotReported("无腹痛腹泻示未涉肺胃气机壅滞", "风团瘙痒3天。无腹痛、腹泻。"), "无腹痛腹泻示未涉肺胃气机壅滞");
});

await check("16.3 鉴别分句开头的「无明确感染灶描述」「牙体检查无异常」不改成「病历未记录…」（甲方病历 7、9）；症状照改（对照）", () => {
  const ground = (points) => {
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", westernDiagnosis: { primary: { name: "荨麻疹" }, differentials: [{ name: "荨麻疹性血管炎", reason: "需排除", distinguishingPoints: points, nextCheck: "皮肤活检" }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
    const out = visible.groundDifferentialNegativeAssertions(content, "风团瘙痒3天，时起时消。");
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).westernDiagnosis.differentials[0].distinguishingPoints;
  };
  assert.equal(ground("无明确感染灶描述"), "无明确感染灶描述");
  assert.equal(ground("牙体检查无异常"), "牙体检查无异常");
  assert.match(ground("无发热"), /病历未记录发热/u);
});

await check("16.4 「风药」不是药名：方义「黑芝麻润燥以制风药之燥」不被当成提到外来药剪成「制之燥」（甲方病历 9）", async () => {
  const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
  assert.equal(knowledge.isKnownTcmHerbName("风药"), false);
  assert.equal(knowledge.isKnownTcmHerbName("贯众"), true, "真正的歧义药名仍是药（对照）");
});

await check("16.5 优先评估项的引文只是一个读数（「生命体征：38.1」）时不出「近来加重还是缓解」题（留出例 S143）；症状引文照出（对照）", async () => {
  const contract = await jiti.import("../src/lib/m02-question-contract.ts");
  const withFinding = (quote) => contract.m02PriorityEvaluationQuestion({ clinicalFacts: { redFlags: [{ category: "other_critical", status: "positive", urgency: "clarify", subject: "patient", quote }] } });
  assert.equal(withFinding("生命体征：38.1"), undefined);
  assert.match(withFinding("近一周右胁持续胀痛") || "", /加重/u);
});

await check("16.6 不给剂量页：注意事项里只是重说饮食栏忌口的那一条不再列；说了饮食栏没有的（戒酒、保暖）照留（留出集 S178/S188/S190）", async () => {
  const surface = await jiti.import("../src/lib/delivered-surface.ts");
  const diet = "饮食宜温热清淡、易消化，少量多餐，忌生冷、辛辣、油腻。";
  assert.equal(surface.dietOnlyPrecautionCoveredBy("饮食宜清淡、易消化，少食辛辣油腻。", diet), true);
  assert.equal(surface.dietOnlyPrecautionCoveredBy("服药期间忌食生冷。", diet), true);
  assert.equal(surface.dietOnlyPrecautionCoveredBy("饮食宜清淡，戒酒。", diet), false, "饮食栏没写酒（对照）");
  assert.equal(surface.dietOnlyPrecautionCoveredBy("注意保暖，避免受寒。", diet), false, "不是饮食（对照）");
  assert.equal(surface.dietOnlyPrecautionCoveredBy("饮食宜清淡、易消化。", ""), false, "饮食栏空（对照）");
});

await check("16.7 不给剂量页的有毒药一句不说「按医生开的剂量」；带剂量页照旧（留出集 S188）", async () => {
  const surface = await jiti.import("../src/lib/delivered-surface.ts");
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "桂附理中丸加减", herbs: [{ name: "附子", role: "君" }, { name: "干姜", role: "臣" }], decoction: { method: "" } }] },
    nonPharma: { diet: "忌生冷。", precautions: ["体温偏低伴嗜睡，请立即就医评估。"] } };
  const line = (options) => surface.projectDeliveredReasoning(reasoning, options).nonPharma.precautions.find((item) => item.includes("附子")) || "";
  assert.match(line({ nonDosePage: true }), /医生面诊后决定/u);
  assert.doesNotMatch(line({ nonDosePage: true }), /医生开的剂量/u);
  assert.match(line({}), /按医生开的剂量/u, "带剂量页（对照）");
});

await check("16.8 证名只有「毒」、治法只说解毒不说清热时不推「热者寒之」（S190 乌头碱中毒）；清热解毒、热毒照旧（对照）", () => {
  const principle = (syndrome, method) => visible.nationalTreatmentPrinciple("", { overview: { primarySyndrome: syndrome }, therapy: { overallMethod: method } });
  assert.equal(principle("毒损心脉证", "解毒通络，护心复脉，和胃降逆"), "实则泻之");
  assert.equal(principle("瘀毒内结证", "化瘀散结，活血解毒"), "实则泻之");
  assert.equal(principle("邪毒闭肺证", "清热解毒，宣肺开闭"), "热者寒之");
  assert.equal(principle("热毒炽盛证", "解毒凉血"), "热者寒之");
});

await check("16.9 忌口随证：「阳气虚衰证」按阳虚写忌生冷（S188）；无寒热的证照旧兜底（对照）", async () => {
  const phrasing = await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
  assert.match(phrasing.dietRestrictionForSyndromeText("阳气虚衰证；温阳益气"), /生冷/u);
  assert.equal(phrasing.dietRestrictionForSyndromeText("胃气不和证；理气和胃"), "饮食宜清淡、易消化，少食辛辣油腻");
});

await check("16.10 解热镇痛抗炎药全身用只留一种（S145 依托考昔/对乙酰氨基酚/布洛芬）；皮肤外用另算、非此类与中成药不动（对照）；编译器接线", async () => {
  const dup = await jiti.import("../src/lib/patent-medicine-duplication.server.ts");
  const row = (name, riskNote, extra = {}) => ({ type: "西药", name, riskNote, usageBoundary: "", ...extra });
  const meds = [
    row("依托考昔片", "服用阿司匹林或其他非甾体类抗炎药后诱发哮喘的患者禁用。"),
    row("对乙酰氨基酚片", "不能同时服用其他含有解热镇痛药的药品（如某些复方抗感冒药）。"),
    row("布洛芬片", "对其他非甾体抗炎药过敏者禁用。"),
    row("双氯芬酸二乙胺乳胶剂", "不能同时使用其他含有解热镇痛药的药品。"),
    row("奥美拉唑肠溶胶囊", "对本品过敏者禁用。"),
    { type: "中成药", name: "元胡止痛片", riskNote: "孕妇慎用。", usageBoundary: "" },
  ];
  assert.deepEqual(dup.withoutSameClassAnalgesics(meds).map((item) => item.name), ["依托考昔片", "双氯芬酸二乙胺乳胶剂", "奥美拉唑肠溶胶囊", "元胡止痛片"]);
  assert.deepEqual(dup.withoutSameClassAnalgesics([meds[1], meds[4]]).map((item) => item.name), ["对乙酰氨基酚片", "奥美拉唑肠溶胶囊"], "只有一种时不动（对照）");
  const source = readFileSync(new URL("../src/lib/m04-proposal-compiler.ts", import.meta.url), "utf8");
  assert.match(source, /withoutRepeatedMedicineNames\(withoutSameClassAnalgesics\(proposal\.patentAndWestern/u, "编译器必须接上");
});

await check("16.11 同一种药不同厂家说明书只推荐一行（一枝篙/一枝蒿伤湿祛痛膏，S145、X-E-0582）；不同药不动（对照）", async () => {
  const dup = await jiti.import("../src/lib/patent-medicine-duplication.server.ts");
  const names = (list) => dup.withoutRepeatedMedicineNames(list.map((name) => ({ name }))).map((item) => item.name);
  assert.deepEqual(names(["一枝篙伤湿祛痛膏", "乳香风湿气雾剂", "一枝蒿伤湿祛痛膏"]), ["一枝篙伤湿祛痛膏", "乳香风湿气雾剂"]);
  assert.deepEqual(names(["云南白药气雾剂", "云南白药膏"]), ["云南白药气雾剂", "云南白药膏"], "剂型不同的两种照留（对照）");
});

await check("16.12 病历无舌象时「舌苔厚腻」整段换成「舌象待核实」，不留「舌舌象待核实腻」（BEST4SDT-270）；有舌象的病历原样（对照）", () => {
  const out = sanitizeOverview("腹胀3天，大便不爽。", { tcmDiagnosticRationale: "兼见腹胀，舌苔厚腻，属湿阻。" }).tcmDiagnosticRationale;
  assert.doesNotMatch(out, /舌舌象|象待核实腻|待核实腻/u, out);
  assert.match(out, /兼见腹胀，舌象待核实，属湿阻/u, out);
  assert.match(sanitizeOverview("腹胀3天，大便不爽。苔黄腻。", { tcmDiagnosticRationale: "兼见腹胀，舌苔厚腻，属湿阻。" }).tcmDiagnosticRationale, /舌苔厚腻/u, "病历有舌象（对照）");
});

await check("16.13 「抽搐痛」「抽搐感」「抽搐样痛」不报神经急症（H-tri-19642）；发作性抽搐照报（对照）", () => {
  assert.equal(gateOf("间断性头抽搐痛七年，每遇情绪紧张时诱发。").redFlags.length, 0);
  assert.equal(gateOf("头痛3月，呈拘急跳痛抽搐感。").redFlags.length, 0);
  assert.equal(gateOf("颈痛五年，左前臂抽搐样痛。").redFlags.length, 0);
  assert.match(gateOf("今晨突发四肢抽搐、口吐白沫2分钟。").redFlags.join("；"), /神经/u);
  assert.match(gateOf("头痛2天，今日抽搐2次。").redFlags.join("；"), /神经/u);
});

await check("16.14 治则：「抑肝扶脾」「扶土抑木」是扶正祛邪（M 集 0372、0092、X-D-5665 曾推成实则泻之）；纯疏肝和胃照旧实则泻之（对照）", () => {
  const principle = (syndrome, method) => visible.nationalTreatmentPrinciple("", { overview: { primarySyndrome: syndrome }, therapy: { overallMethod: method } });
  assert.equal(principle("肝气乘脾证", "抑肝扶脾，化湿止泻"), "扶正祛邪");
  assert.equal(principle("脾虚肝旺证", "扶土抑木，理脾平肝"), "扶正祛邪");
  assert.equal(principle("肝胃不和证", "疏肝和胃"), "实则泻之");
  assert.equal(principle("肾阳虚证", "温补肾阳"), "虚则补之");
});

await check("16.15 治法里只差第一个字的四字短语留一个（「和血通络，活血通络」SD-451922）；不同治法照留（对照）", async () => {
  const phrasing = await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("平肝潜阳，滋养肝肾，和血通络，活血通络"), "平肝潜阳，滋养肝肾，和血通络");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("清肝泻火，清心泻火"), "清肝泻火，清心泻火", "差的不是第一个字（对照）");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("健脾益气，化湿止泻"), "健脾益气，化湿止泻");
});

await check("16.16 饮食段逐小句去掉方中有毒/孕妇慎用药当食物的推荐（「…忌辛辣；可适量吃山楂、桃仁入膳」test-375，「可少量食用桃仁煮粥」test-488）；忌口小句照留（对照）", async () => {
  const surface = await jiti.import("../src/lib/delivered-surface.ts");
  const diet = (text) => surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "血府逐瘀汤", herbs: [{ name: "桃仁", role: "君" }, { name: "红花", role: "君" }], decoction: { method: "" } }] },
    nonPharma: { diet: text } }, {}).nonPharma.diet;
  assert.equal(diet("饮食宜清淡易消化，少食辛辣油腻；可适量吃山楂、桃仁入膳，忌过饱。"), "饮食宜清淡易消化，少食辛辣油腻；忌过饱。");
  assert.equal(diet("饮食宜清淡易消化，可少量食用桃仁煮粥或桃仁炒菜，忌辛辣油腻及生冷。"), "饮食宜清淡易消化，忌辛辣油腻及生冷。");
  assert.equal(diet("饮食宜清淡，忌食桃仁等活血之品。"), "饮食宜清淡，忌食桃仁等活血之品。", "忌口（对照）");
  const yiyi = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "参苓白术散", herbs: [{ name: "薏苡仁", role: "臣" }, { name: "茯苓", role: "臣" }], decoction: { method: "" } }] },
    nonPharma: { diet: "饮食清淡，可常食薏苡仁煮粥，忌生冷。" } }, {}).nonPharma.diet;
  assert.equal(yiyi, "饮食清淡，可常食薏苡仁煮粥，忌生冷。", "药食同源、非活血攻下（薏苡仁）当食物照常（对照）");
});

await check("16.17 「为兼夹之象」「属兼夹」「…为兼」算自称兼夹，交给兼证一致核对（M 集 0516、test-65、BEST4SDT-6）；存疑说法不算（对照）", async () => {
  const phrasing = await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
  const claims = (syndrome, rationale) => phrasing.mechanismClaimsUncoveredBy(syndrome, rationale).filter((clause) => phrasing.declaresSecondaryMechanism(clause));
  assert.equal(claims("气阴两虚证", "舌红苔黄示水湿内停、郁而化热，为兼夹之象；").length, 1);
  assert.equal(claims("痰气郁结证", "双尺重按无力示下元不足为兼。").length, 1);
  assert.equal(claims("痰火扰神证", "痰火轻重与是否兼夹他邪尚待四诊补充。").length, 0, "存疑（对照）");
  assert.equal(claims("寒湿痹阻证", "寒热虚实兼夹暂难细辨。").length, 0, "存疑（对照）");
});

await check("16.18 家族史一栏的心衰不算患者本人的剂量边界（MTCMB-21「母亲健在，患有冠心病、心力衰竭」）；患者本人心衰照收回（对照）", () => {
  const reasons = (symptoms) => safety.highRiskDoseBoundaryReasons(types.normalizeCaseStateInput({ chiefComplaint: "头晕3年", symptoms, patient: { age: 56, sex: "女" } })).join("；");
  assert.doesNotMatch(reasons({ 现病史: "阵发性头晕。", 家族史: "父亲已经去世，母亲健在，患有冠心病、心力衰竭；兄弟姐妹均体健。" }), /心力衰竭/u);
  assert.match(reasons({ 现病史: "阵发性头晕，慢性心力衰竭3年，活动后气短。", 家族史: "否认家族遗传病史。" }), /心力衰竭/u, "本人心衰（对照）");
});

await check("16.19 「后头部头痛明显」「后枕部胀痛」不当人名脱敏（MTCMB-72）；「患者后建国」照脱敏（对照）", () => {
  assert.equal(safety.sanitizeFreeTextForModel("头胀，后头部头痛明显，前额部头胀明显。"), "头胀，后头部头痛明显，前额部头胀明显。");
  assert.equal(safety.sanitizeFreeTextForModel("后枕部胀痛3天。"), "后枕部胀痛3天。");
  assert.match(safety.sanitizeFreeTextForModel("患者后建国头痛3天。"), /已脱敏/u);
});

await check("16.20 上消化道警示征象的理由只写命中的那一类（SD-433219：只有体重下降，理由不写吞咽梗阻）；判定不变（对照）", () => {
  const weight = gateOf("胃脘隐痛3年，近半年体重下降约5公斤，纳差。").redFlags.join("；");
  assert.match(weight, /上消化道警示征象（不明原因体重下降）/u);
  assert.doesNotMatch(weight, /吞咽/u);
  const block = gateOf("进行性吞咽困难2月，进食梗阻感。").redFlags.join("；");
  assert.match(block, /上消化道警示征象（吞咽或进食梗阻）/u);
  assert.equal(gateOf("胃脘隐痛3年，纳差，体重无明显变化。").redFlags.length, 0, "无警示征象（对照）");
});

await check("16.21 只有口唇发绀时理由写发绀，不写「呼吸困难/端坐呼吸」（SD-451922）；端坐呼吸照旧（对照）", () => {
  const cyanosis = gateOf("头晕1月。查体：口唇发绀，爪甲青紫。").redFlags.join("；");
  assert.match(cyanosis, /中心性发绀/u);
  assert.doesNotMatch(cyanosis, /端坐呼吸/u);
  assert.match(gateOf("气喘3天，夜间不能平卧。").redFlags.join("；"), /端坐呼吸/u);
});

await check("16.22 病历事实核对：只有一次标到的否定说法（「腹不胀大」「与咳唾呼吸无关」）也交复核（M 集鉴别 16 处）；只标到一次的肯定说法仍不交（对照）", async () => {
  const claim = await jiti.import("../src/lib/m03-patient-claim-check.server.ts");
  const first = [{ field: "d0", span: "腹不胀大" }, { field: "d1", span: "干咳无痰" }, { field: "d2", span: "胀痛固定" }];
  const second = [{ field: "d1", span: "干咳无痰" }, { field: "d3", span: "与咳唾呼吸无关" }];
  const spans = claim.patientClaimCandidatesForVerification(first, second).map((item) => item.span).sort();
  assert.deepEqual(spans, ["与咳唾呼吸无关", "干咳无痰", "腹不胀大"].sort());
  assert.ok(!spans.includes("胀痛固定"), "只一次标到的肯定说法（对照）");
});

await check("16.23 病历「无汗出，偶有胸痛」「无头痛，有胸痛」算记录了胸痛：鉴别里「本例无胸痛」被改正（MTCMB-14）；病历真否认的照旧不改（对照）", async () => {
  const differential = (record) => {
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", overview: { tcmDiseaseDifferentials: [{ diseaseName: "胸痹", distinguishingPoints: "本例以阵发性心慌为主症，无胸痛" }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
    const out = safety.sanitizeUngroundedRedFlagNegations(content, stateOf(record));
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).overview.tcmDiseaseDifferentials[0].distinguishingPoints;
  };
  assert.match(differential("阵发性心慌，伴有手足抖动，无汗出，偶有胸痛，偶有咳嗽。"), /病历已记录胸痛阳性/u);
  assert.match(differential("阵发性心慌，无头痛，有胸痛。"), /病历已记录胸痛阳性/u);
  assert.equal(differential("阵发性心慌，无胸痛，偶有头晕。"), "本例以阵发性心慌为主症，无胸痛", "病历否认（对照）");
});

await check("16.24 兼证核对补上兼证后：依据里「尚未成独立证候，暂作兼夹」分句去掉、治法同义去重（MTCMB-21、SD-451922）；「属兼夹而非主证」算断言（BEST4SDT-194）；其余句子不动（对照）", async () => {
  const consistency = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
  const phrasing = await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
  const root = { overview: { secondarySyndromes: [], tcmDiagnosticRationale: "头晕耳鸣、腰酸示肝肾不足，故主证为肝阳上亢；苔腻、痰多，痰湿尚未成独立证候，暂作兼夹因素处理；口苦为肝火。", overallPathogenesis: "肝肾阴亏，肝阳上扰清窍。" },
    therapy: { overallMethod: "平肝潜阳，滋养肝肾，和血通络" } };
  assert.equal(consistency.applySecondaryConsistencyDecision(root, { decision: "add", secondarySyndrome: "痰湿内蕴证", method: "活血通络", evidence: ["苔腻", "痰多"] }), true);
  assert.doesNotMatch(root.overview.tcmDiagnosticRationale, /尚未成独立证候|暂作兼夹/u, root.overview.tcmDiagnosticRationale);
  assert.match(root.overview.tcmDiagnosticRationale, /口苦为肝火/u, "其余句子（对照）");
  assert.equal(root.therapy.overallMethod, "平肝潜阳，滋养肝肾，和血通络");
  const claims = phrasing.mechanismClaimsUncoveredBy("阴虚喉痹证", "腹冷便溏属兼夹而非主证。").filter((clause) => phrasing.declaresSecondaryMechanism(clause));
  assert.equal(claims.length, 1);
  assert.equal(phrasing.mechanismClaimsUncoveredBy("阴虚喉痹证", "腹冷便溏，非兼夹。").filter((clause) => phrasing.declaresSecondaryMechanism(clause)).length, 0, "否认兼夹（对照）");
});

await check("16.25 治则：纯痰湿实证的「健脾和胃」不算扶正（MTCMB-77/8）；肝阳头痛＋气血不足是扶正祛邪（MTCMB-72）；阴虚火旺仍是虚则补之、脾虚湿盛仍扶正祛邪（对照）", () => {
  const principle = (syndrome, method, secondary = []) => visible.nationalTreatmentPrinciple("", { overview: { primarySyndrome: syndrome, secondarySyndromes: secondary }, therapy: { overallMethod: method } });
  assert.equal(principle("痰湿中阻证", "化痰祛湿，健脾和胃，升清止晕"), "实则泻之");
  assert.equal(principle("肝阳头痛", "平肝潜阳，理气通络，益气养血", ["气血不足证"]), "扶正祛邪");
  assert.equal(principle("阴虚火旺证", "滋阴清火，养心安神"), "虚则补之");
  assert.equal(principle("脾虚湿盛证", "健脾化湿"), "扶正祛邪");
});

await check("16.26 「无神疲乏力」「无关节痛」是对症状的否认，病历没写时改成「未诉」（SD-468043、SD-482122）；「神清无神」「与进食无关」不动（对照）", () => {
  assert.equal(visible.unrecordedNegativesAsNotReported("本例无神疲乏力，与虚劳区分", "便血3天，肛门坠胀。"), "本例未诉神疲乏力，与虚劳区分");
  assert.equal(visible.unrecordedNegativesAsNotReported("本例无关节痛，属皮痹", "皮肤硬化半年。"), "本例未诉关节痛，属皮痹");
  assert.equal(visible.unrecordedNegativesAsNotReported("本例神清无神，属脱证", "神昏2小时。"), "本例神清无神，属脱证");
  assert.equal(visible.unrecordedNegativesAsNotReported("与进食无关", "胃痛3天。"), "与进食无关");
});

await check("16.27 同义组：「咳喘」算气促（BEST4SDT-73）、「体重下降」算消瘦（SD-433219）——鉴别里的「无气促」「无消瘦」被改正；病历没有的照旧（对照）", () => {
  const point = (record, text) => {
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", overview: { tcmDiseaseDifferentials: [{ diseaseName: "肺胀", distinguishingPoints: text }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
    const out = safety.sanitizeUngroundedRedFlagNegations(content, stateOf(record));
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).overview.tcmDiseaseDifferentials[0].distinguishingPoints;
  };
  assert.match(point("咳嗽1月，入夜则咳喘加重。", "本例无气促"), /气促阳性/u);
  assert.match(point("胃脘痛半年，体重下降约20kg。", "本例无消瘦"), /消瘦阳性/u);
  assert.doesNotMatch(point("咳嗽1月，咳白痰。", "本例无气促"), /阳性/u, "病历无（对照）");
});

await check("16.28 注意事项「龙齿捣碎后同煎」与药表龙齿先煎相抵，去掉这一小句（BEST4SDT-139）；无特殊煎法的「桃仁捣碎后同煎」照留（对照）；用药风险说明里的「；；」收成一个", async () => {
  const surface = await jiti.import("../src/lib/delivered-surface.ts");
  const project = (herbs, precautions) => surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "x", herbs, decoction: { method: "龙齿先煎30分钟，余药加水浸泡后同煎。" } }],
      patentAndWestern: [{ type: "西药", name: "布洛芬片", riskNote: "对本品过敏者禁用。；；孕妇慎用。。" }] },
    nonPharma: { diet: "清淡。", precautions } }, {});
  const out = project([{ name: "龙齿", role: "君", decoctionRequirement: "先煎" }, { name: "桃仁", role: "臣" }], ["龙齿捣碎后同煎，服药期间忌辛辣。", "桃仁捣碎后同煎，孕妇忌服。"]);
  const lines = out.nonPharma.precautions.join("|");
  assert.doesNotMatch(lines, /龙齿捣碎后同煎/u, lines);
  assert.match(lines, /桃仁捣碎后同煎/u, "无特殊煎法（对照）");
  assert.equal(out.formula.patentAndWestern[0].riskNote, "对本品过敏者禁用。孕妇慎用。");
});

await check("16.29 鉴别「无明显诱因、皮损沿一侧神经分布且以刺痛为主」：描述性并列项不在否认作用域里，整句不改；病历写着否认的一项保留「无」、只改没写到的（甲方病历 8 漆疮）", () => {
  const rec = "患者五天前无明显诱因出现左侧胁肋部针刺样疼痛，三天前发现左侧胁肋部片状红斑，其上可见水疱。";
  const point = (text) => {
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", overview: { tcmDiseaseDifferentials: [{ diseaseName: "漆疮", distinguishingPoints: text }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
    const out = visible.groundDifferentialNegativeAssertions(content, rec);
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).overview.tcmDiseaseDifferentials[0].distinguishingPoints;
  };
  assert.match(point("本例无明显诱因、皮损沿一侧神经分布且以刺痛为主，无接触漆类史"), /^本例无明显诱因、皮损沿一侧神经分布且以刺痛为主，病历未记录接触漆类史/u);
  assert.match(point("无明显诱因、接触漆类史"), /^无明显诱因，病历未记录接触漆类史/u);
  assert.match(point("本例无接触漆类史"), /病历未记录接触漆类史/u, "只有未记录项（对照）");
});

await check("16.30 病名写成教材某病下的一型（「石淋·湿热蕴结证」）且表里没有以它为名的节时，用那一行（淋证·石淋，石韦散；留出例 S067 曾落到外科五神汤）；鼻渊、虚劳·肺脾两虚照旧不借（对照）", async () => {
  const t = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
  const row = t.textbookRowForSyndrome("石淋", "湿热蕴结证");
  assert.equal(row?.disease, "淋证");
  assert.deepEqual(row?.formulas, ["石韦散"]);
  assert.equal(t.textbookRowForSyndrome("鼻渊", "胆腑郁热证"), undefined);
  assert.equal(t.textbookRowForSyndrome("虚劳", "肺脾两虚证"), undefined);
});

console.log(JSON.stringify({ suite: "r1019-round4", cases, failures: process.exitCode ? "see above" : 0 }));
