/**
 * r1019 红旗与追问整改（2026-10-19）的断言。未登记进闸门（由协调方决定）。
 *
 * 依据：~/runlogs/r1018/work/r1019/agentB（红旗验收 A/M 67 例失败与追问验收 B 39 例失败的逐例归类、语料回放）。
 * 每一节对应一类问题；每条断言都跑过反证：把 src 换成改前 HEAD（R1019_SRC 指向只回退了本轮改动的副本）后必须变红，
 * 反证结果记在报告里。
 *
 *   A 安全门（确定性）：慢性局灶缺损、腹痛语境（否定线索、痛经、慢性间歇、腹泻绞痛、命名体征、梗阻三联）、
 *     便血复发时间窗、被取代的院外血压、无靶器官表现的重度高血压（提示不收剂量；儿童、妊娠照旧）、
 *     上消化道警示的部位与年份、中医意识改变写法、中医言语/肢体缺损写法与慢性守卫的补强（A8）、呕血口语写法（A9）
 *   S 阴性净化器：带限定词的否认不改成普通症状阳性；两遍净化结果相同
 *   F 语义事实层：消化道出血按 other_immediate_threat 升急诊的证据下限；明确少量鲜红肛门来源便血最多 urgent；
 *     只凭血压读数的急诊最多 urgent；口语呕血与「呕血」同一显性出血语言（F3）
 *   Q 追问：脉象选项互斥判据；舌脉并问拆题；单问点核对只给题干；重复核对的新规则；急症筛查题的四种去向；
 *     出题提示词；新生儿不问寒热
 */
import assert from "node:assert/strict";
import path from "node:path";
import { createJiti } from "jiti";

const SRC = process.env.R1019_SRC ? path.resolve(process.env.R1019_SRC) : path.resolve(process.cwd(), "src");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": SRC,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const lib = (name) => jiti.import(path.join(SRC, "lib", name));

const failures = [];
let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message.slice(0, 400) : String(error) });
  }
};

const safety = await lib("diagnosis-safety.ts");
const { normalizeCaseStateInput } = await lib("diagnosis-types.ts");
const state = (text, patient = { sex: "男", age: 50 }, extra = {}) =>
  normalizeCaseStateInput({ id: `r1019-${cases}`, chiefComplaint: "", conversation: [], patient, symptoms: { 现病史: text }, ...extra });
const gate = (text, patient, extra) => safety.withSafetyGate(state(text, patient, extra)).safetyGate;
const flags = (text, patient, extra) => gate(text, patient, extra).redFlags || [];
const hasFlag = (text, pattern, patient, extra) => flags(text, patient, extra).some((item) => pattern.test(item));

// ───── A 安全门 ─────
const NEURO = /神经系统急症/;
const ABDOMEN = /急腹症/;
const GI_BLEED = /活动性消化道出血/;
const BP = /重度高血压/;
const GI_ALARM = /上消化道警示征象/;

await check("A1.1 一个月以上的局灶缺损（病程写在缺损后或作起病锚点）不报神经急症", () => {
  for (const text of ["左侧肢体无力2年。", "双下肢无力半年，右侧明显，近2个月行走不稳。", "脑梗死后左侧肢体无力半年。", "右侧半身不遂3年余，头晕。",
    "10岁起反复出现发作性右侧偏瘫，时伴言语不清或右侧肢体麻木感，1小时后可完全缓解，每年2-3次。", "右侧肢体麻木半年。"]) {
    assert.ok(!hasFlag(text, NEURO), `「${text}」仍报神经急症`);
  }
});
await check("A1.2 起病不足一个月、或一个月内加重/突发的照旧报（对照）", () => {
  for (const text of ["左侧肢体无力2天。", "左侧肢体活动不利伴头痛半月。", "近2周出现左侧肢体无力。", "左侧肢体无力2年，3天前加重。",
    "左侧肢体无力2年，近3天加重。", "左侧肢体无力2年，今晨突然加重。", "1年余前出现双下肢无力，1周前肢体无力加重。", "高血压10年，右侧肢体无力。",
    "头晕2年伴右侧肢体无力。"]) {
    assert.ok(hasFlag(text, NEURO), `「${text}」应报神经急症`);
  }
});
await check("A2.1 腹痛：被否认的加重线索不算（「无明显加重」）", () => {
  for (const text of ["偶有上腹胀满，无明显加重及缓解因素。", "腹痛，无明显加重。", "上腹痛半年，未见明显加重。"]) {
    assert.ok(!hasFlag(text, ABDOMEN), `「${text}」仍报急腹症`);
    assert.notEqual(gate(text).status, "red_flag");
  }
  assert.ok(hasFlag("腹痛明显加重2天。", ABDOMEN), "未否认的加重照旧报（对照）");
});
await check("A2.2 腹痛：痛经、慢性规律里的间歇剧痛、腹泻里的绞痛不算急腹症", () => {
  for (const text of ["经行腹痛剧烈。", "痛经，经期小腹绞痛。", "胃脘胀痛难忍2年。", "便时腹部疼痛，有时轻微有时剧烈，持续已一年有余。",
    "腹泻3日，伴腹部绞痛。", "腹泻2天，腹部绞痛，无便血。"]) {
    assert.ok(!hasFlag(text, ABDOMEN), `「${text}」仍报急腹症`);
  }
});
await check("A2.3 腹痛：妊娠可疑、急性起病、程度词单独成句、腹泻带血、胃痛与经期分属不同小句时照旧报（对照）", () => {
  for (const text of ["停经50天，下腹剧痛。", "反复胃痛3年，腹痛剧烈，按之痛甚，伴发热。", "胃痛2年，今日腹痛剧烈难忍，伴呕吐。", "腹部绞痛3小时。",
    "腹泻3日，伴腹部绞痛，便中带血。", "胃脘隐痛8年，近3天加重，疼痛难忍。", "胃痛剧烈，伴嗳气，经前腹痛。"]) {
    assert.ok(hasFlag(text, ABDOMEN), `「${text}」应报急腹症`);
  }
});
await check("A2.4 命名的阑尾/胆囊体征、肠梗阻查体与影像征、未排便≥5天＋腹痛＋呕吐报急腹症", () => {
  for (const text of ["2天来发热38℃，上腹痛后转移至右下腹。麦氏点有压痛，无反跳痛和肌紧张，腰大肌征阳性。", "Murphy征阳性。", "转移性右下腹痛1天。",
    "腹膨隆，见肠型，肠鸣音亢进，有气过水声。", "立位腹平片见多个气液平面，腹痛。", "无排便7天，腹痛、呕吐2天，平素便秘。", "5天未解大便，腹痛，伴呕吐。"]) {
    assert.ok(hasFlag(text, ABDOMEN), `「${text}」应报急腹症`);
  }
});
await check("A2.5 阴性写法、胸部影像、短于5天或无呕吐的未排便、慢性便秘不报（对照）", () => {
  for (const text of ["麦氏点无压痛及反跳痛，Murphy's征－。", "麦氏点压痛（-），腰大肌征阴性。", "胸部CT：右肺脓肿伴气液平。", "无排便3天，腹胀，无呕吐。",
    "4天未解大便，恶心，呕吐两次，腹胀。", "大便三四日一行，腹胀。", "腹部平坦，无胃肠型和蠕动波。", "肠鸣音亢进。"]) {
    assert.ok(!hasFlag(text, ABDOMEN), `「${text}」误报急腹症`);
  }
});
await check("A3.1 下消化道出血的反复/多次没有7天内时间窗时不算活动性出血", () => {
  for (const text of ["近1月反复出现便血色红。", "痔疮反复便血。", "反复便血2年，色鲜红，量少。", "便血反复发作半年余。", "近1周反复便后滴血。"]) {
    assert.ok(!hasFlag(text, GI_BLEED), `「${text}」仍报活动性出血`);
  }
});
await check("A3.2 上消化道出血、7天内的反复、量与灌注不足照旧报（对照）", () => {
  for (const text of ["反复黑便3天。", "便血反复3天。", "反复便血2年，近3天再次便血。", "多年来反复便血，最近几天又出现了复发。",
    "反复便血20余年，加重1周。", "我患吐血症状已超过两年，但多次复发。", "便血3次，伴头晕。", "大量便血1天。"]) {
    assert.ok(hasFlag(text, GI_BLEED), `「${text}」应报活动性出血`);
  }
});
await check("A4.1 院外/急诊的危急读数在处置后被本次查体读数取代", () => {
  const measured = safety.currentVitalMeasurements(state("自测血压180/107mmHg，遂就诊于我院急诊，予硝酸甘油泵后症状缓解。生命体征：血压164/97mmHg。"));
  assert.deepEqual(measured.bloodPressure, { systolic: 164, diastolic: 97 });
  assert.ok(!hasFlag("10小时前头晕，于本院急诊就诊，时测血压190/101mmHg，予倍他司汀后好转。体格检查：血压：172/96mmHg。", BP));
  assert.ok(!hasFlag("在家自测血压200/110mmHg，含服硝苯地平后复测150/90mmHg。", BP));
});
await check("A4.2 没有处置、或本次读数同样危急时照旧取危急读数（对照）", () => {
  assert.deepEqual(safety.currentVitalMeasurements(state("自测血压190/110mmHg。生命体征：血压150/90mmHg。")).bloodPressure, { systolic: 190, diastolic: 110 });
  assert.deepEqual(safety.currentVitalMeasurements(state("自测血压200/110mmHg，今日门诊血压190/110mmHg。")).bloodPressure, { systolic: 200, diastolic: 110 });
  assert.deepEqual(safety.currentVitalMeasurements(state("先测血压120/80mmHg，复测185/118mmHg。")).bloodPressure, { systolic: 185, diastolic: 118 });
});
await check("A5.1 重度高血压无急性靶器官表现：不报红旗、不收剂量，给醒目提示", () => {
  for (const text of ["血压200/120mmHg，头晕。", "血压190/120mmHg，无胸闷胸痛，无头痛。", "门诊血压213/122mmHg，阵发性头晕头胀伴心慌，无胸闷胸痛。", "左侧肢体活动不利3年，血压190/110mmHg。"]) {
    const result = gate(text);
    assert.ok(!(result.redFlags || []).some((item) => BP.test(item)), `「${text}」仍报重度高血压红旗`);
    assert.ok((result.advisories || []).some((item) => /【重度高血压】/.test(item) && /今日规范复测/.test(item)), `「${text}」没有醒目提示`);
    const permission = safety.derivePrescriptionPermission(state(text));
    assert.notEqual(permission.candidateMode, "non_dose_only", `「${text}」收回了剂量`);
  }
});
await check("A5.2 伴急性靶器官表现、未满18岁、妊娠时照旧报红旗（对照）", () => {
  for (const text of ["血压190/120mmHg，伴剧烈头痛、呕吐。", "自测血压200/120mmHg，伴胸痛。", "血压200/110mmHg，偶有胸闷。", "患者头晕，无头痛，心慌，偶有胸闷，无胸痛。血压197/133mmHg。",
    "血压190/110mmHg，视物模糊。", "语言不利1天，血压220/130mmHg。", "阵发性头痛，加重1天，血压238/147mmHg。", "突感恶心呕吐，头痛，不能走路，血压240/150mmHg。",
    "血压180/110mmHg，今晨突发左侧肢体无力。"]) {
    assert.ok(hasFlag(text, BP), `「${text}」应报重度高血压红旗`);
  }
  assert.ok(hasFlag("头痛3天，血压190/125mmHg。", BP, { sex: "女", age: 15 }), "15 岁 190/125 照旧报（AAP 2017）");
  assert.ok(hasFlag("孕32周，头痛。血压185/118mmHg。", /妊娠\/产褥期血压/, { sex: "女", age: 30 }), "妊娠期照旧按产科阈值报");
  assert.ok(hasFlag("血压70/40mmHg。", /低血压/), "低血压不受影响");
});
await check("A6.1 上消化道警示：非消化道部位的包块、以公历年份开头的既往经过不算", () => {
  assert.ok(!hasFlag("左乳浸润性导管癌术后化疗后。双乳超声示：左乳包块（BI-RADS4b级）。食纳欠佳。", GI_ALARM));
  assert.ok(!hasFlag("2017年10月患者出现胸闷气短，伴乏力、体重下降，考虑恶性肿瘤。刻下：纳呆。", GI_ALARM));
  assert.ok(hasFlag("胃癌术后，上腹可及包块。", GI_ALARM), "消化道包块照旧报（对照）");
  assert.ok(hasFlag("肺癌化疗后，近1月体重下降5kg。", GI_ALARM), "当前体重下降照旧报（对照）");
});
await check("A7.1 中医意识改变写法（神志昏沉、神识昏蒙、神昏谵语）报神经急症；头昏沉、精神昏沉、否认不报", () => {
  for (const text of ["神志昏沉，闭目蜷卧。", "伴神志昏沉、言语混乱。", "神昏谵语。", "高热，神识昏蒙。"]) assert.ok(hasFlag(text, NEURO), `「${text}」应报`);
  for (const text of ["头昏沉。", "精神昏沉，乏力。", "无神志昏沉。"]) assert.ok(!hasFlag(text, NEURO), `「${text}」误报`);
});

await check("A8.1 中医言语、肢体缺损写法（言语不利、语言不利、言语蹇涩、四肢/双下肢活动不利）当前起病时报神经急症，不必伴高血压", () => {
  for (const text of ["语言不利1天。", "今晨突发言语不利。", "双下肢活动不利2天，伴小便困难。", "四肢活动不利3天。", "今晨突发言语蹇涩。",
    "患者2小时前突然出现语言不利，口角流涎。"]) {
    assert.ok(hasFlag(text, NEURO), `「${text}」应报神经急症`);
  }
});
await check("A8.2 同一批写法的后遗症、慢性病程（含复述、慢性进展、N个多月/N天）不报；单侧下肢、关节活动不利与否认不报", () => {
  for (const text of ["中风后遗症，言语不利3年。", "四肢活动不利10余年。", "脑梗死后2年，遗留言语不利。", "语言不利2年。刻下：语言不利，无饮水呛咳。",
    "四肢活动不利伴言语不利3个多月。刻下：四肢活动不利，言语不利。", "进行性双下肢走路不稳3年，加重伴言语不利3个月。",
    "双下肢活动不利半年，逐渐加重。", "肢体活动不利半年，逐渐加重。", "言语蹇涩32天。言语蹇涩，右侧肢体乏力。", "左侧口眼歪斜40天。",
    "语言不利、定向力和思维能力下降1年，加重2个月。", "腰痛伴左下肢活动不利1周。", "否认言语不利及肢体活动不利。", "四肢关节肿痛，活动不利。"]) {
    assert.ok(!hasFlag(text, NEURO), `「${text}」仍报神经急症`);
  }
});
await check("A8.3 一个月内的加重、新近复述、对侧新缺损、意识改变、胸闷的恶化型加重照旧报（对照）", () => {
  for (const text of ["言语不利2年。3天来言语不利明显。", "言语不利1年，加重3天。", "双下肢活动不利半年，近3天逐渐加重。", "左侧肢体无力2年。右侧肢体无力。",
    "右侧肢体活动不利，言语不利已有半个月；刻下右侧肢体活动不利，言语不利。", "经行神志不清一年。每次行经时神志不清，胡言乱语。"]) {
    assert.ok(hasFlag(text, NEURO), `「${text}」应报神经急症`);
  }
  assert.ok(hasFlag("胸闷气短30余年，加重1月余。", /胸闷/), "胸闷的「加重1月余」不受神经慢性进展守卫影响");
  const both = flags("语言不利1天，血压220/130mmHg。");
  assert.ok(both.some((item) => NEURO.test(item)) && both.some((item) => BP.test(item)), JSON.stringify(both));
});
await check("A9.1 呕血的口语写法（呕红、呕吐鲜血、呕吐物含血/带血/为血性、呕出血）进上消化道出血", () => {
  for (const text of ["反复呕红便血已有3个月，夜间睡眠不安。", "今晨呕红2次，头晕心慌。", "恶心呕吐，呕吐物含血块，伴头晕乏力。", "饮酒后呕吐鲜血，量约200ml，面色苍白。",
    "昨晚起呕出血块两次，黑便。", "呕吐物为血性，伴晕厥一次。"]) {
    assert.ok(hasFlag(text, GI_BLEED), `「${text}」应报活动性消化道出血`);
  }
  assert.ok(safety.hasGiBleedPrioritySignal("呕吐物中有鲜红血块。"), "单独的口语呕血进优先评估档");
});
await check("A9.2 否认、咯吐、无血的呕吐物不算（对照）", () => {
  for (const text of ["无呕红。", "否认呕吐物带血。", "咳嗽，咳吐红痰。", "呕吐物无血，为胃内容物。", "否认呕血、呕吐鲜血。"]) {
    assert.ok(!hasFlag(text, GI_BLEED), `「${text}」误报`);
    assert.ok(!safety.hasGiBleedPrioritySignal(text), `「${text}」误进优先评估档`);
  }
});

// ───── S 阴性净化器 ─────
const sanitize = (text, record) => safety.sanitizeUngroundedRedFlagNegations(text, normalizeCaseStateInput({
  id: `r1019-s-${cases}`, chiefComplaint: "", conversation: [], patient: {}, symptoms: { presentHistory: record },
}));
await check("S1.1 带限定词的否认不改成普通症状阳性，两遍净化结果相同（甲方病历 3 第 2 次生成）", () => {
  const record = "两个多月前患者生产后出现头痛，呈隐痛，时发时止，伴头晕、心悸。";
  for (const text of ["本例头痛隐痛、时发时止逾两月，无突发剧烈头痛、喷射性呕吐。", "未诉肢体偏瘫、神昏等中风表现，无剧烈头痛，故与二者区分。", "鉴别要点：本例无突发头痛。"]) {
    const once = sanitize(text, record);
    assert.ok(!/头痛阳性/.test(once), `「${text}」被改成头痛阳性：${once}`);
    assert.equal(sanitize(once, record), once, `两遍结果不同：${once}`);
  }
  assert.equal(sanitize("鉴别要点：本例无突发头痛。", record), "鉴别要点：本例无突发头痛。", "否认的限定写法原样保留");
});
await check("S1.2 病历写了带限定的那一种、或模型否认的就是普通症状时照旧改正（对照）", () => {
  assert.match(sanitize("鉴别要点：本例无剧烈头痛。", "突发剧烈头痛2小时。"), /已记录剧烈头痛[^；]*阳性/);
  assert.match(sanitize("鉴别要点：本例无剧烈头痛。", "头痛剧烈，伴呕吐。"), /头痛阳性/);
  assert.match(sanitize("本例无头痛。", "头痛2月，呈隐痛。"), /头痛阳性/);
  assert.match(sanitize("胃脘痞塞满闷不舒，无明显呕吐。", "脘腹胀满，恶心呕吐。"), /呕吐阳性/, "「明显」不算限定词");
});

// ───── F 语义事实层 ─────
{
  delete process.env.CDSS_CLINICAL_FACTS_BACKSTOP;
  const facts = await lib("clinical-facts.ts");
  const ground = (finding, source) => {
    const parsed = facts.parseClinicalFacts(JSON.stringify({ redFlags: [{ subject: "patient", status: "positive", ...finding }] }));
    return facts.groundClinicalFacts(parsed, source).redFlags[0];
  };
  await check("F1.1 消化道出血按 other_immediate_threat 标 emergency：没有大出血或灌注不足证据时最多 urgent", () => {
    const finding = ground({ category: "gi_bleed", urgency: "emergency", triageBasis: "other_immediate_threat", quote: "便血，色鲜红，量少" },
      "肛门疼痛，便后尤甚，伴便血，色鲜红，量少，无发热恶寒。");
    assert.equal(finding.urgency, "urgent");
  });
  await check("F1.2 明确少量、鲜红、肛门直肠来源的便血：多日也不升急诊", () => {
    const finding = ground({ category: "gi_bleed", urgency: "urgent", triageBasis: "urgent_review", quote: "伴少量便血，色鲜红" },
      "肛内坠胀不适，近3天大便日行1-2次，伴少量便血，色鲜红，无腹痛。");
    assert.equal(finding.urgency, "urgent");
  });
  await check("F1.3 大量、伴灌注不足、黑便时照旧急诊（对照）", () => {
    assert.equal(ground({ category: "gi_bleed", urgency: "emergency", triageBasis: "other_immediate_threat", quote: "大量便血伴头晕" }, "今日大量便血伴头晕，面色苍白。").urgency, "emergency");
    assert.equal(ground({ category: "gi_bleed", urgency: "urgent", triageBasis: "urgent_review", quote: "黑便2天" }, "黑便2天，伴头晕乏力。").urgency, "emergency");
  });
  await check("F2.1 只凭血压读数的急诊、病历没有急性靶器官表现：最多 urgent", () => {
    const finding = ground({ category: "vital_instability", urgency: "emergency", triageBasis: "extreme_vital_instability", quote: "血压230/135mmHg" },
      "头晕头胀1周，无胸闷胸痛，无头痛。血压230/135mmHg。");
    assert.equal(finding.urgency, "urgent");
  });
  await check("F2.2 伴急性靶器官表现时照旧急诊（对照）", () => {
    const finding = ground({ category: "vital_instability", urgency: "emergency", triageBasis: "extreme_vital_instability", quote: "血压230/135mmHg" },
      "头晕1天，伴胸痛。血压230/135mmHg。");
    assert.equal(finding.urgency, "emergency");
  });
  await check("F3.1 口语呕血（呕红、呕吐物含血块）与「呕血」同一显性出血语言：伴头晕乏力时升急诊", () => {
    assert.equal(ground({ category: "gi_bleed", urgency: "urgent", triageBasis: "urgent_review", quote: "呕红2次" }, "今晨呕红2次，伴头晕乏力。").urgency, "emergency");
    assert.equal(ground({ category: "gi_bleed", urgency: "urgent", triageBasis: "urgent_review", quote: "呕吐物含血块" }, "恶心呕吐，呕吐物含血块，头晕。").urgency, "emergency");
    assert.equal(ground({ category: "gi_bleed", urgency: "urgent", triageBasis: "urgent_review", quote: "咳吐红痰" }, "咳嗽，咳吐红痰，头晕。").urgency, "urgent", "咳吐红痰不是显性消化道出血（对照）");
  });
}

// ───── Q 追问 ─────
{
  Object.assign(process.env, {
    AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.deepseek.com",
    OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", PRIMARY_QUESTION_MODEL: "deepseek-flash",
    CDSS_CLINICAL_FACTS_BACKSTOP: "false", CDSS_M02_PRECOMPUTE_NO_ANSWER: "false", CDSS_SMALL_TASK_MEMO: "false",
  });
  const textbook = await lib("tcm-textbook-syndromes.ts");
  const contract = await lib("m02-question-contract.ts");
  const redundancy = await lib("m02-question-redundancy.server.ts");
  const answerability = await lib("m02-risk-question-answerability.server.ts");
  const prompts = await lib("diagnosis-prompts.ts");
  const START = "<!-- DIAGNOSIS_JSON_START -->";
  const END = "<!-- DIAGNOSIS_JSON_END -->";
  const planOf = (content) => JSON.parse(content.slice(content.indexOf(START) + START.length, content.indexOf(END))).m02Plan;
  const option = (id, value) => ({ id, label: value, answer: value, kind: "clinical_fact", recordValue: value });
  const question = (stem, a, b, branch = "syndrome") => ({
    id: "q1", question: stem, reason: "两种情况对应不同证型，用方不同。", targetField: "xianbingshi", decisionBranch: branch,
    expectedDecisionImpact: "区分两种候选证型。", informationGain: 0.7, sourceEvidence: [],
    options: [option("a", a), option("b", b), { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" }],
  });
  const envelope = (...questions) => [START, JSON.stringify({ m02Plan: { schemaVersion: "tcm-cdss-m02-plan-v1", decision: "ask", rationale: "需要一条区分证型的事实。", questions } }), END].join("\n");

  await check("Q1.1 脉象选项互斥：相反脉类才互斥；子集、带「或」、带小儿指纹小句的不算", () => {
    const exclusive = textbook.pulseOptionsMutuallyExclusive;
    assert.equal(exclusive("脉滑实，指纹紫滞", "脉细数"), true);
    assert.equal(exclusive("脉濡", "脉沉弦滑"), true);
    assert.equal(exclusive("脉浮紧", "脉沉细"), true);
    assert.equal(exclusive("脉细数，指纹紫滞", "脉数，指纹紫滞"), false);
    assert.equal(exclusive("脉浮或浮紧", "脉濡数或滑"), false);
    assert.equal(exclusive("脉弱或沉缓", "脉沉紧"), false);
    assert.equal(exclusive("脉弦紧", "脉弦"), false);
    assert.equal(textbook.withoutFingerVeinClause("脉细数，指纹紫滞"), "脉细数");
  });
  await check("Q2.1 舌象与脉象并问：舌象没记录时改成只问舌象，选项取舌象半句", () => {
    const content = envelope(question("舌象与脉象更接近下列哪一组？", "舌红苔黄腻，脉弦滑数", "舌淡苔白，脉细弱"));
    const split = contract.splitTonguePulseQuestions(content, "胃脘胀闷2周，嗳气。", {});
    const plan = planOf(split.content);
    assert.deepEqual(split.removeIds, []);
    assert.equal(plan.questions[0].question, "本例的舌象更接近下面哪一种？");
    assert.deepEqual(plan.questions[0].options.slice(0, 2).map((item) => item.answer), ["舌红苔黄腻", "舌淡苔白"]);
    assert.equal(plan.questions[0].targetField, "tcmTongue");
  });
  await check("Q2.2 舌象已记录时改问脉象；两半都不互斥时删题；单问舌象的题不动（对照）", () => {
    const pulse = planOf(contract.splitTonguePulseQuestions(envelope(question("舌象与脉象更接近哪一组？", "舌红苔黄腻，脉弦滑数", "舌淡苔白，脉沉细")), "舌象：舌红苔薄。", {}).content);
    assert.equal(pulse.questions[0].question, "本例的脉象更接近下面哪一种？");
    const removed = contract.splitTonguePulseQuestions(envelope(question("舌象与脉象更接近哪一组？", "舌苔厚腻，脉弦", "舌红苔黄腻，脉弦滑")), "胃痛3天。", {});
    assert.deepEqual(removed.removeIds, ["q1"]);
    const tongueOnly = envelope(question("舌苔是什么颜色？", "苔黄腻", "苔薄白"));
    assert.equal(contract.splitTonguePulseQuestions(tongueOnly, "胃痛3天。", {}).content, tongueOnly);
  });
  await check("Q7.1 模型写的单问舌象题：选项不互斥（「舌红，苔黄」对「舌红，苔薄黄」，甲方病历 7 第 1 次生成）删题；单问脉象题同理", () => {
    const removed = contract.splitTonguePulseQuestions(envelope(question("舌苔更接近下列哪一种？", "舌红，苔黄", "舌红，苔薄黄")), "右侧下牙胀痛3天。", {});
    assert.deepEqual(removed.removeIds, ["q1"]);
    const pulse = contract.splitTonguePulseQuestions(envelope(question("脉象更接近哪一种？", "脉弦数", "脉弦")), "胃痛3天。", {});
    assert.deepEqual(pulse.removeIds, ["q1"]);
    assert.equal(textbook.tongueOptionsMutuallyExclusive("舌苔厚腻", "舌淡苔腻"), false, "厚腻与腻都是腻苔");
  });
  await check("Q7.2 互斥的单问舌象题：各选项共有的小句（预设的舌红）去掉，题干按剩下的内容改成问舌苔；互斥判据读得出「苔黄厚」", () => {
    assert.equal(textbook.tongueOptionsMutuallyExclusive("舌红，苔黄厚或黄腻", "舌红，苔薄黄"), true);
    assert.equal(textbook.tongueOptionsMutuallyExclusive("舌红少苔", "舌苔薄白"), true);
    const split = contract.splitTonguePulseQuestions(envelope(question("舌象更接近以下哪一种？", "舌红，苔黄厚或黄腻", "舌红，苔薄黄")), "右侧下牙胀痛3天。", {});
    assert.deepEqual(split.removeIds, []);
    const plan = planOf(split.content);
    assert.equal(plan.questions[0].question, "本例的舌苔更接近下面哪一种？");
    assert.deepEqual(plan.questions[0].options.slice(0, 2).map((item) => [item.label, item.answer, item.recordValue]),
      [["苔黄厚或黄腻", "苔黄厚或黄腻", "苔黄厚或黄腻"], ["苔薄黄", "苔薄黄", "苔薄黄"]]);
    const mismatch = planOf(contract.splitTonguePulseQuestions(envelope(question("舌苔更接近哪一种？", "舌红，苔黄", "舌淡，苔白")), "胃痛3天。", {}).content);
    assert.equal(mismatch.questions[0].question, "本例的舌象更接近下面哪一种？", "题干问舌苔、选项也分舌质时改成问舌象");
  });
  await check("Q7.3 互斥、无共有小句、题干与选项一致的舌象题和脉象题不动（对照：甲方病历 8 三次生成评审判合格的题）", () => {
    for (const content of [
      envelope(question("舌象更接近下列哪一项？", "舌质红，苔薄黄或黄厚", "舌淡或正常，苔白或白腻")),
      envelope(question("脉象更接近哪一种？", "脉浮数", "脉沉细")),
      envelope(question("舌苔是什么颜色？", "苔黄腻", "苔薄白")),
    ]) {
      const split = contract.splitTonguePulseQuestions(content, "胃痛3天。", {});
      assert.deepEqual(split.removeIds, []);
      assert.equal(split.content, content);
    }
  });
  await check("Q8.1 服务端基本问诊题的选项不带「或」（「口不渴，或只想喝少量热水」评审判不能直接写进病历）", () => {
    const seen = new Set();
    for (const record of ["胃痛3天。", "胃痛3天，怕冷。", "胃痛3天，怕冷，口不渴。", "胃痛3天，怕冷，口不渴，大便调。"]) {
      const content = contract.basicInquiryFallback(record, { ageDays: 40 * 365 }) || "";
      const options = [...content.matchAll(/^[AB]\. (.+)$/gmu)].map((match) => match[1]);
      assert.equal(options.length, 2, content);
      for (const option of options) assert.ok(!/或/u.test(option), `选项「${option}」带或`);
      seen.add(content.split("\n")[0]);
    }
    assert.equal(seen.size, 4, "寒热、口渴、大便、汗四项都核到");
  });
  const savedFetch = globalThis.fetch;
  const completion = (payload) => new Response(JSON.stringify({
    id: "t", object: "chat.completion", model: "deepseek-flash",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { "content-type": "application/json" } });
  await check("Q3.1 单问点核对只给题干（不给选项），提示词不再把「更接近下面哪一种」当单问点的例子", async () => {
    const bodies = [];
    try {
      globalThis.fetch = async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return completion({ verdict: "single", points: [] });
      };
      await redundancy.questionIdsFailingNarrowChecks(envelope(question("胃痛时对冷热的反应如何？", "得温痛减", "得温不减")), "胃痛3天。", "");
    } finally {
      globalThis.fetch = savedFetch;
    }
    const singlePoint = bodies.find((body) => body.messages?.[0]?.content?.includes("题干是不是要患者分别回答两个不同对象的情况"));
    assert.ok(singlePoint, "没有发出单问点核对");
    assert.deepEqual(Object.keys(JSON.parse(singlePoint.messages[1].content)), ["question"]);
    assert.ok(!singlePoint.messages[0].content.includes("“更接近下面哪一种？”"));
    assert.ok(singlePoint.messages[0].content.includes("涕液性状与全身寒热表现更接近哪一种"));
    assert.ok(singlePoint.messages[0].content.includes("“大便的气味和性状更接近哪一种”"), "同一对象的几项特征必须作为单问点示例");
    assert.ok(singlePoint.messages[0].content.includes("最困扰的是气短自汗、易感冒，还是食少胃胀、便溏"), "题干自列两组证候表现的选择题必须作为单问点示例");
    const repeat = bodies.find((body) => body.messages?.[0]?.content?.includes("追问题与病历的重复核对器"));
    assert.ok(repeat.messages[0].content.includes("病历写着“无腹痛拒按”"), "重复核对提示词缺「选项已被病历否认」一条");
  });
  await check("Q9.1 重复核对：「只问哪组为主、各组表现病历都写了」单列一类且优先于 not_answered（甲方病历 5）；判 partly 且引文逐字时删题", async () => {
    const record = "反复感冒1+年\n平素伴易疲乏、短气自汗、声音低怯，食欲下降，进食稍多或滋腻则胃胀不适，小便清长，大便稀溏。";
    const content = envelope(question("平素最困扰的主要是气短自汗、易感冒，还是食少胃胀、大便稀溏？", "平素以气短自汗、易感冒为主要困扰", "平素以食少胃胀、大便稀溏为主要困扰"));
    const bodies = [];
    let removed;
    try {
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        return completion(body.messages[0].content.includes("追问题与病历的重复核对器")
          ? { verdict: "partly", quotes: ["短气自汗、声音低怯", "进食稍多或滋腻则胃胀不适", "大便稀溏"], reason: "两组表现均已写明" }
          : { verdict: "single", points: [] });
      };
      removed = await redundancy.questionIdsFailingNarrowChecks(content, record, "");
    } finally {
      globalThis.fetch = savedFetch;
    }
    const repeat = bodies.find((body) => body.messages?.[0]?.content?.includes("追问题与病历的重复核对器"));
    const system = repeat.messages[0].content;
    assert.ok(/主次题：题干只问“哪一组\/哪一项为主/u.test(system), "缺主次题一类");
    assert.ok(system.includes("这条优先于 not_answered"), "主次题须写明优先于 not_answered");
    assert.ok(!system.includes("各选项列的表现病历里都已经写了、题干只问哪一组更突出或以哪一组为主"), "旧的附带说法应已并入主次题");
    assert.deepEqual(removed, ["q1"]);
  });
  await check("Q4.1 急症筛查核对：已写明正在发生 → affirmed；已否认其中几项 → partly；引文不逐字 → open", () => {
    const record = "便血3天，血为鲜红色，肚子有点疼。无头晕。";
    const verdict = (payload) => answerability.riskQuestionRecordVerdict(JSON.stringify(payload), record);
    assert.equal(verdict({ verdict: "answered_positive", quotes: ["血为鲜红色"] }), "affirmed");
    assert.equal(verdict({ verdict: "partly_answered", quotes: ["无头晕"] }), "partly");
    assert.equal(verdict({ verdict: "answered_negative", quotes: ["无头晕"] }), "answered");
    assert.equal(verdict({ verdict: "answered_positive", quotes: ["大量鲜血"] }), "open");
    assert.equal(verdict({ verdict: "not_answered", quotes: [] }), "open");
    assert.equal(answerability.recordAnswersRiskQuestion(JSON.stringify({ verdict: "answered_positive", quotes: ["血为鲜红色"] }), record), false, "旧接口语义不变");
  });
  const giBleedUrgent = { redFlags: [{ category: "gi_bleed", status: "positive", urgency: "urgent", quote: "带有黑便" }] };
  const melena = { patient: { sex: "男", age: 21 }, chiefComplaint: "拉肚子3天", symptoms: { presentHistory: "拉肚子3天，带有黑便，量时少时多。" }, clinicalFacts: giBleedUrgent };
  const melenaRecord = "拉肚子3天\n拉肚子3天，带有黑便，量时少时多。";
  await checkAsync("Q4.2 病历已写明黑便：不再强制出「是否确实出现…」，记为 affirmed", async () => {
    try {
      globalThis.fetch = async () => completion({ verdict: "answered_positive", quotes: ["带有黑便"] });
      const status = await answerability.riskCategoryRecordStatus(melena, melenaRecord);
      assert.deepEqual(status, { answered: [], affirmed: ["gi_bleed"], partly: [] });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
  async function checkAsync(name, run) { await check(name, run); }
  await check("Q4.3 affirmed 类目：固定筛查题不再前置，模型写的题照用；没核对时照旧前置（对照）", () => {
    const fixed = "本次是否确实出现柏油样黑便、鲜血便或呕血？";
    const modelQuestion = question("黑便是柏油样黑亮黏稠，还是仅颜色偏深、质地如常？", "柏油样黑亮黏稠", "仅颜色偏深、质地如常", "triage");
    const finalize = (stateArg) => planOf(contract.enforceM02UnansweredAxes(
      contract.ensureQuestionStructuredEnvelope(envelope(modelQuestion), melenaRecord, contract.buildCaseAwareQuestionFallback(stateArg)),
      melenaRecord, contract.buildCaseAwareQuestionFallback(stateArg, { settled: true }), stateArg));
    assert.equal(finalize({ ...melena, m02AffirmedRiskCategories: ["gi_bleed"] }).questions[0].question, modelQuestion.question);
    assert.equal(finalize(melena).questions[0].question, fixed);
  });
  await check("Q4.4 partly 类目：模型的澄清题（triage）照用；模型没写澄清题时仍出固定筛查题", () => {
    const abdomen = { patient: { sex: "男", age: 3 }, chiefComplaint: "右下腹痛", symptoms: { presentHistory: "右下腹间歇性痛，晚上痛醒，恶心呕吐没有。" },
      clinicalFacts: { redFlags: [{ category: "acute_abdomen", status: "positive", urgency: "urgent", quote: "晚上痛醒" }] }, m02ModelOwnedRiskCategories: ["acute_abdomen"] };
    const record = "右下腹痛\n右下腹间歇性痛，晚上痛醒，恶心呕吐没有。";
    const finalize = (provider) => planOf(contract.enforceM02UnansweredAxes(
      contract.ensureQuestionStructuredEnvelope(envelope(provider), record, contract.buildCaseAwareQuestionFallback(abdomen)),
      record, contract.buildCaseAwareQuestionFallback(abdomen, { settled: true }), abdomen));
    const triage = question("按压右下腹再松手时，是否疼得更厉害？", "松手时疼得更厉害", "松手时疼痛不加重", "triage");
    assert.equal(finalize(triage).questions[0].question, triage.question);
    const syndrome = question("大便干硬还是稀溏？", "大便干硬", "大便稀溏");
    assert.match(finalize(syndrome).questions[0].question, /反跳痛/);
  });
  await check("Q5.1 出题提示词：affirmed/partly 线索带 recordStatus；舌脉只问其一；选项只写题干问的那一项", () => {
    const caseState = normalizeCaseStateInput({ id: "r1019-prompt", chiefComplaint: "拉肚子3天", conversation: [], patient: { sex: "男", age: 21 },
      symptoms: { presentHistory: "拉肚子3天，带有黑便。" } });
    caseState.clinicalFacts = { redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", urgency: "urgent", quote: "带有黑便" }] };
    const text = prompts.buildQuestionPrompt(caseState, [], { affirmed: ["gi_bleed"] });
    assert.ok(text.includes("\"recordStatus\":\"affirmed\""), "affirmed 线索没有标记");
    assert.ok(text.includes("标了 recordStatus=affirmed 的"));
    assert.ok(text.includes("一题只问其中一项"));
    assert.ok(!text.includes("优先问舌脉（选项写两种候选证型各自的典型舌脉）"));
    assert.ok(text.includes("否定选项只写题干所列表现的否定"));
  });
  await check("Q6.1 未满 28 天的新生儿不问「怕冷还是怕热」，换下一项基本问诊；两个月照问（对照）", () => {
    assert.equal(contract.m02PatientAgeDays("10天"), 10);
    assert.equal(contract.m02PatientAgeDays("2个月"), 60);
    assert.equal(contract.m02PatientAgeDays("", "宝宝出生8天，黄疸。"), 8);
    const neonate = contract.basicInquiryFallback("血的检验结果帮忙看一下", { ageDays: 10 });
    assert.ok(neonate && !/怕冷还是怕热|想喝凉的还是热的/.test(neonate), neonate);
    assert.ok(!/怕冷还是怕热/.test(contract.basicInquiryFallback("宝宝两岁，发高烧39.6，烧的发抖。", { ageDays: 730 }) || ""), "发烧、发抖已记录时不问寒热");
    assert.match(contract.basicInquiryFallback("咳嗽2天", { ageDays: 60 }), /怕冷还是怕热/);
    const fallback = contract.buildCaseAwareQuestionFallback({ patient: { age: "10天" }, chiefComplaint: "血的检验结果帮忙看一下" }, { settled: true });
    assert.ok(!/怕冷还是怕热/.test(fallback), fallback);
  });
}

const summary = { suite: "r1019-safety-m02", src: SRC, cases, failures };
console.log(JSON.stringify(summary, null, 1));
if (failures.length > 0) process.exitCode = 1;
