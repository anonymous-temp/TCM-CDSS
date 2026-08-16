/**
 * 口语与书面语同权：六类零检出的收口，外加暴露出来的两处结构性缺陷。
 *
 * 【背景】2026-08-16 逐类标定 docs/未完项清单 里挂着的六类「口语零检出」。
 * 关键做法是**先给每一类找一个同义且已经命中的书面兄弟**，档位由兄弟定，不自己发明：
 *
 *   类别      兄弟（修复前已命中）                    目标口语（修复前 0）
 *   心血管    「心前区闷得慌2小时，大汗」硬红旗        「心前区发闷2小时，冒虚汗」
 *   神经      「突发复视、步态不稳」硬红旗            「看东西成双影，走路发飘，今天突然开始」
 *   呼吸      「喘不上气，不能平卧」硬红旗            「喘得厉害，晚上躺不平，得垫两个枕头」
 *   晕厥      「晕厥发作」提示档                     「眼前一黑就倒了」
 *   儿科      「患儿拒食拒饮，精神萎靡」提示档         「4岁孩子不吃不喝，精神很差」
 *   中毒      「有机磷农药中毒」提示档                「误喝了敌敌畏」
 *
 * 后三类只到提示档是 hardGateRequires 的有意设计（要求客观测量或器官功能障碍），
 * 本轮**不动档位**，只让口语达到与书面语相同的那一档。
 *
 * 【查出来的两处结构性缺陷，比补词重要】
 *
 * ① 儿童判据四处各写各的，漏的那处在安全层。
 *    三处写 `(age != null && age < 18) || (age == null && hasQualitativePediatricContext(state))`，
 *    唯独**儿童危重提示**那处只写了后半截。而 hasQualitativePediatricContext 的结构化分支
 *    只读 hisRecord.fields.age 与 patient.sex——`patient.age` 根本不在读取列表里；
 *    文本分支又要求儿童词在**分句开头**，「4岁患儿精神萎靡」也不算。
 *    实测：patient.age=4 + 「精神萎靡，反应差」⇒ 儿童危重提示 0 条。
 *    修法是收敛成 isPediatricPatient 单一谓词，不是在第四处补 if（补 if 只是四处变五处）。
 *
 * ② 急性线索**后置**的语序整类漏检，书面语一起漏。
 *    「今天突然出现复视、行走不稳」红旗 1；「复视、行走不稳，今天突然出现」红旗 0。
 *    这不是口语问题——中文病历把时间放句尾极常见。反向写法本仓早有一份
 *    （acuteCueAfterDeficit），却被关在「陈旧卒中残留」分支里且只覆盖 FOCAL_NEUROLOGIC_PATTERN。
 *    已提成 TRAILING_ACUTE_NEURO_CUE 供两处共用。
 *
 * 【补词不能凭直觉：这几个词加了会出真误报】
 * 实测 8 条常规门诊主诉修复前全是 0 红旗 0 提示，而它们恰好含有最直觉的那批口语词：
 *   躺不平（腰痛）、垫高枕头（颈椎病）、冒虚汗（更年期）、没精神（失眠）、
 *   摔倒在地（老人跌倒）、不吃不喝（小儿厌食）。
 * 因此端坐呼吸只作构词式（口语词必须与呼吸线索同句），其余四个词进 excludedTerms 并记明理由。
 *
 * 【合并共享常量时踩的一脚，留作后人参考】
 * 把 acuteCueAfterDeficit 提成共享常量后，「右侧手指麻木**反复发作**10余年」被判成神经系统急症——
 * 「反复发作」里含「复发」。前向 acuteCue 早就带着 `(?<!反)` 回看，被提取的那份没有
 * （在原分支里撞不上，合并后就撞上了）。由 test:safety-mutations 当场抓出。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
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
const { withSafetyGate, isPediatricPatient } = await jiti.import("../src/lib/diagnosis-safety.ts");

const BASE = {
  id: "colloquial-parity", phase: "diagnose",
  tongue: "舌淡红苔薄白", pulse: "脉弦",
  vitals: "T36.6℃ P80次/分 R18次/分 BP128/80mmHg",
  pastHistory: "", medicationHistory: "", allergyHistory: "",
  questionRounds: 1, maxQuestionRounds: 1, conversation: [],
  diagnosis: "", prescription: "", riskAssessment: "",
};
const ADULT = { sex: "男", age: 62 };
const CHILD = { sex: "男", age: 4 };
const gateFor = (text, patient = ADULT) => withSafetyGate({
  ...BASE, patient,
  chiefComplaint: text,
  symptoms: { general: text, tcmFourExams: "" },
}).safetyGate;

// ── 1. 口语必须达到其书面兄弟的档位（兄弟一并断言，防止兄弟先坏了却没人发现）──
const PARITY = [
  { label: "心血管", tier: "hard", pattern: /心血管|冠脉/,
    sibling: "心前区闷得慌2小时，大汗", colloquial: "心前区发闷2小时，冒虚汗" },
  { label: "神经", tier: "hard", pattern: /神经系统急症/,
    sibling: "今天突然出现复视、行走不稳", colloquial: "看东西成双影，走路发飘，今天突然开始" },
  { label: "呼吸", tier: "hard", pattern: /呼吸循环急症/,
    sibling: "喘不上气，不能平卧", colloquial: "喘得厉害，晚上躺不平，得垫两个枕头" },
  { label: "晕厥", tier: "advisory", pattern: /晕厥、黑矇/,
    sibling: "晕厥发作，意识丧失数分钟后自行恢复", colloquial: "今天上午眼前一黑就倒了，几分钟才缓过来" },
  { label: "儿科", tier: "advisory", pattern: /儿童全身危重/, patient: CHILD,
    sibling: "患儿拒食拒饮，精神萎靡，嗜睡", colloquial: "4岁孩子不吃不喝，精神很差，一直睡" },
  { label: "中毒", tier: "advisory", pattern: /可疑中毒或药物过量/,
    sibling: "有机磷农药中毒", colloquial: "误喝了敌敌畏半小时，恶心呕吐、流口水" },
];
for (const item of PARITY) {
  for (const [kind, text] of [["书面兄弟", item.sibling], ["口语", item.colloquial]]) {
    const gate = gateFor(text, item.patient || ADULT);
    const pool = item.tier === "hard" ? gate.redFlags : [...gate.redFlags, ...(gate.advisories || [])];
    assert.ok(
      pool.some((entry) => item.pattern.test(entry)),
      `${item.label}·${kind} 应达到 ${item.tier === "hard" ? "硬红旗" : "提示档"}：${text}\n`
      + `实得 红旗=${JSON.stringify(gate.redFlags)} 提示=${JSON.stringify(gate.advisories || [])}`,
    );
  }
}

// ── 2. 常规门诊主诉不得被抬档（这批含有最直觉、但会误报的那些口语词）────────
const BENIGN = [
  ["腰痛3年，夜间躺不平，翻身困难", { sex: "女", age: 45 }],
  ["颈椎病，睡觉需垫高枕头，晨起颈项僵硬", { sex: "女", age: 45 }],
  ["气短乏力，动则汗出，时有虚汗，纳差便溏", { sex: "女", age: 45 }],
  ["失眠多梦2年，白天没精神，情绪低落", { sex: "女", age: 45 }],
  ["老人晨起下地时不慎摔倒在地，左髋疼痛", { sex: "女", age: 78 }],
  ["更年期潮热盗汗，夜间冒虚汗，心烦易怒", { sex: "女", age: 51 }],
  ["慢性咳嗽3个月，晨起咳痰，无喘息", { sex: "女", age: 45 }],
  ["小儿厌食半年，不吃不喝挑食，形体消瘦，精神尚可", CHILD],
  // 「反复发作」含「复发」——共享常量补 (?<!反) 回看之前，这条被判成神经系统急症
  ["右侧手指麻木反复发作10余年，每年冬季发作", { sex: "女", age: 58 }],
  // 这条是「冒虚汗」不进心血管伴随词表的真正理由：伴随词单独不成门，
  // 必须与心血管症状同现才危险，而「胸闷、气短、动则汗出」正是气虚常规主诉。
  // （第一次写反例时我挑了「更年期潮热盗汗」，那条根本没有心血管症状，
  //   所以加了虚汗也不会红——反例选错了，不是断言空转。）
  ["胸闷气短2年，动则加重，夜间时有冒虚汗，纳差乏力", { sex: "女", age: 52 }],
];
for (const [text, patient] of BENIGN) {
  const gate = gateFor(text, patient);
  assert.equal(
    gate.redFlags.length, 0,
    `常规门诊主诉不得产生硬红旗：${text}\n实得 ${JSON.stringify(gate.redFlags)}`,
  );
}

// ── 3. 儿童判据：结构化年龄这一分支必须被读到 ──────────────────────────────
{
  const structuredOnly = { ...BASE, patient: CHILD, chiefComplaint: "精神萎靡，反应差",
    symptoms: { general: "精神萎靡，反应差", tcmFourExams: "" } };
  assert.ok(
    isPediatricPatient(structuredOnly),
    "patient.age=4 必须直接判定为儿童病例——文本里没有「患儿」二字不能成为理由",
  );
  const gate = gateFor("精神萎靡，反应差", CHILD);
  assert.ok(
    (gate.advisories || []).some((entry) => /儿童全身危重/.test(entry)),
    `结构化年龄 4 岁 + 精神萎靡 必须产出儿童危重提示，实得 ${JSON.stringify(gate.advisories)}`,
  );
  // 非句首的「4岁患儿」此前也不算——文本判据锚在分句开头
  assert.ok(
    (gateFor("4岁患儿精神萎靡，反应差", CHILD).advisories || []).some((entry) => /儿童全身危重/.test(entry)),
    "「4岁患儿…」这种非句首写法同样必须命中",
  );
  // 成人不得误报
  assert.ok(
    !isPediatricPatient({ ...structuredOnly, patient: ADULT }),
    "成人不得被判成儿童病例",
  );
  assert.equal(
    (gateFor("精神萎靡，反应差", ADULT).advisories || []).filter((entry) => /儿童/.test(entry)).length, 0,
    "成人病例不得出现儿童危重提示",
  );
}

// ── 4. 急性线索后置：两种语序必须同权 ──────────────────────────────────────
const ORDERINGS = [
  ["今天突然出现复视、行走不稳", "复视、行走不稳，今天突然出现"],
  ["今天突然开始看东西成双影，走路发飘", "看东西成双影，走路发飘，今天突然开始"],
];
for (const [cueFirst, cueLast] of ORDERINGS) {
  for (const text of [cueFirst, cueLast]) {
    assert.ok(
      gateFor(text).redFlags.some((flag) => /神经系统急症/.test(flag)),
      `急性线索在前在后必须同权：${text}\n实得 ${JSON.stringify(gateFor(text).redFlags)}`,
    );
  }
}

// ── 5. 词表是唯一来源：代码里不得再出现被收敛掉的那份行内字面量 ────────────
{
  const source = readFileSync(path.join(repoRoot, "src/lib/diagnosis-safety.ts"), "utf8");
  assert.ok(
    !/hasAnyTerm\(text, \["误服", "过量服用", "整瓶", "整盒", "中毒", "农药", "毒物"\]\)/.test(source),
    "中毒提示档的行内字面量必须已被词表取代——它此前与词表 poisoning.symptoms 各写各的且已分叉",
  );
  assert.ok(
    !/hasAnyTerm\(text, \["晕厥", "黑矇", "意识丧失"\]\)/.test(source),
    "晕厥提示档必须读词表而不是手抄一份同样的三个词",
  );

  const lexicon = JSON.parse(readFileSync(path.join(repoRoot, "src/data/redflag-triage-lexicon.json"), "utf8"));
  const rule = (id) => lexicon.categoryRules.find((item) => item.id === id);

  // 代码侧原有的四个词必须已并入词表，否则收敛就是静默削弱检出
  for (const term of ["过量服用", "整瓶", "整盒", "毒物"]) {
    assert.ok(
      rule("poisoning").symptoms.includes(term),
      `收敛时必须把代码侧独有的「${term}」并入词表，否则等于悄悄少认一类`,
    );
  }

  // 六类都必须带 detection 节，且排除项要写明理由（防止有人日后"顺手"把它们加回去）
  for (const id of ["cardiac", "neuro", "respiratory", "syncope", "pediatric_critical", "poisoning"]) {
    assert.ok(rule(id).detection, `${id} 必须有 detection 节`);
  }
  for (const id of ["cardiac", "syncope", "pediatric_critical"]) {
    const detection = rule(id).detection;
    assert.ok(
      Array.isArray(detection.excludedTerms) && detection.excludedTerms.length > 0,
      `${id} 必须记下被排除的口语词`,
    );
    assert.ok(
      typeof detection.excludedTermsBasis === "string" && detection.excludedTermsBasis.length > 10,
      `${id} 的排除项必须写明理由——否则下一个人会以为是漏了而把它加回去`,
    );
  }
  // 端坐呼吸必须是构词式，不能退化成独立症状词
  assert.ok(
    Array.isArray(rule("respiratory").detection.orthopneaBreathingCues)
    && rule("respiratory").detection.orthopneaBreathingCues.length > 0,
    "端坐呼吸口语必须保留呼吸线索要求：单独「躺不平/垫高枕头」是腰痛与颈椎病的常规写法",
  );
}

console.log("test-colloquial-redflag-parity: OK", {
  parityClasses: PARITY.length,
  benignControls: BENIGN.length,
  orderings: ORDERINGS.length * 2,
});
