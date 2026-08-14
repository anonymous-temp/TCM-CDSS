/**
 * 口语化表述的确定性红旗覆盖。
 *
 * 【背景：这是本仓库反复出现的同一种缺陷的第三、第四例】
 * 2026-08-13 鲁棒性专项用「医生按患者原话录入」的写法扫了 19 条各类急症，实测
 * **确定性红旗零检出 13 条**。词表本身没错，错在它按「完整书面词」穷举，
 * 而中文口语换个说法就整条失配——同一根因此前已在腹痛构词式（ABDOMINAL_PAIN_COMPOSITION）
 * 和神经科同义词组（FOCAL_NEUROLOGIC_CONCEPT_GROUPS）上各修过一轮。
 *
 * 本轮修掉并由本套件钉住的两条，都是时间窗最紧的：
 *   · **急性卒中口语**：「说话说不清楚，嘴角歪了，一侧手脚没劲，1小时前突然出现」——
 *     修复前线上实测确定性红旗 0 条、模型语义提示也 0 条，status 只到 needs_information。
 *     漏因逐词可查：词表有「说话不清」而口语是「说话说不清楚」（前者并不连续出现）；
 *     有「口角歪斜」而口语是「嘴角歪了」；有「单侧无力/肢体无力」而口语是「一侧手脚没劲」。
 *   · **消化道出血口语**：「拉的大便又黑又亮，人发晕」——clinical-facts.ts 的
 *     OVERT_GI_BLEED_LANGUAGE 早就收了「又黑又亮/黑得发亮」这批口语，**承重的确定性层却没有**，
 *     且检出口自己另抄了一份短词表。两层词表必须同源：模型层一停，最口语的写法就全裸奔。
 *
 * 【为什么不能只靠模型语义回补层】
 * 该层按设计是 additive-only，且依赖主模型可用。2026-08-12 主模型账户欠费停摆 8 小时，
 * 那段时间里这些病历会一条红旗都没有。承重的必须是确定性层。
 *
 * 【已知仍未覆盖的口语（本轮**不**在此断言，留待中医师定阈值）】
 * 心前区发闷+冒虚汗、复视+走路发飘、喘得厉害躺不平、眼前一黑就倒了、
 * 4岁孩子不吃不喝精神差、误喝农药。其中脓毒症/产科出血/代谢危象三类是
 * hardGateRequires 有意要求「客观测量或器官功能障碍」，属设计取舍而非漏检。
 */
import assert from "node:assert/strict";
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
const { withSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");

const BASE = {
  id: "colloquial-suite", phase: "diagnose", patient: { sex: "男", age: 62 },
  tongue: "舌淡红苔薄白", pulse: "脉弦",
  vitals: "T36.6℃ P80次/分 R18次/分 BP128/80mmHg",
  pastHistory: "", medicationHistory: "", allergyHistory: "",
  questionRounds: 1, maxQuestionRounds: 1, conversation: [],
  diagnosis: "", prescription: "", riskAssessment: "",
};
const redFlagsFor = (text, patient) => withSafetyGate({
  ...BASE, ...(patient ? { patient } : {}),
  chiefComplaint: text, symptoms: { general: text, tcmFourExams: "" },
}).safetyGate.redFlags;

// ── 急性卒中：书面语与口语必须同权 ──────────────────────────────────────────
const STROKE_PHRASINGS = [
  "1小时前突发言语不清、口角歪斜、单侧肢体无力",           // 书面语基线
  "说话说不清楚，嘴角歪了，一侧手脚没劲，1小时前突然出现", // 线上实测漏检的原句
  "今早突然嘴歪，说话说不清，右边手脚没劲",
  "刚才突然半边没劲，抬不起胳膊，说话费劲",
];
for (const text of STROKE_PHRASINGS) {
  const flags = redFlagsFor(text);
  assert.ok(
    flags.some((flag) => /神经系统急症/.test(flag)),
    `急性卒中表述应触发神经系统急症红旗：${text}\n实得：${JSON.stringify(flags)}`,
  );
}

// 后遗症基线不得被读成新发（否则每一个中风后遗症复诊病人都会天天弹红旗）
const STROKE_NOT_ACUTE = [
  "脑梗死后遗留左侧肢体无力3年，本次因失眠就诊",
  "中风后遗症，遗留口角歪斜和言语不清，病情稳定2年",
  "急诊脑CT示脑梗死。经治疗后遗留右半身无力、行动不灵活、语言不利6个月",
  "双手指及右耳垂反复红肿麻木10年，每年冬季发作，受热后瘙痒",
];
for (const text of STROKE_NOT_ACUTE) {
  const flags = redFlagsFor(text);
  assert.ok(
    !flags.some((flag) => /神经系统急症/.test(flag)),
    `陈旧后遗症不得触发急性神经红旗：${text}\n实得：${JSON.stringify(flags)}`,
  );
}

// ── 消化道出血：口语走**提示档**，书面语 + 严重度证据才走硬门档 ────────────────
//
// 这里要写清楚一件我一开始读错的事：口语「拉的大便又黑又亮」确定性红旗为 0，
// **不等于**确定性层没覆盖它。T6 对 gi_bleed 的 hardGateRequires 是
// active_or_recurrent_bleeding_with_severity_evidence，口语档按设计由
// narrativeFallbackAdvisories 承接为非阻断提示——test-clinical-facts 里有一条刻意的断言钉着
// 「模型不可用时口语『大便发黑』只形成非阻断提示」。我曾把口语伴随症（没力气/人发晕）
// 加进严重度词表，等于把提示档提成硬门档，闸门当场红。那条红是对的。
//
// 真正的缺口只有一处：词表根本没收「又黑又亮/黑得发亮/解柏油样便」这批口语，
// 于是它们**连提示档都进不去**（红旗 0、提示也 0）。补进概念分组后提示档覆盖到了，
// 硬门边界一寸未动。
const { narrativeFallbackAdvisories } = await jiti.import("../src/lib/diagnosis-safety.ts");
const giAdvisoriesFor = (text) =>
  narrativeFallbackAdvisories({ chiefComplaint: text, conversation: [] }).filter((item) => /消化道出血/.test(item));

const GI_BLEED_COLLOQUIAL = [
  "拉的大便又黑又亮，人发晕",       // 线上实测：修复前红旗 0、提示也 0
  "大便黑得发亮，这两天没力气",
  "解柏油样便，脸色发白",
  "老人家最近大便发黑好几天了，人也没力气", // 既有断言钉住的那一条，必须仍是提示档
];
for (const text of GI_BLEED_COLLOQUIAL) {
  assert.ok(giAdvisoriesFor(text).length > 0, `口语消化道出血应形成非阻断提示：${text}`);
  assert.deepEqual(
    redFlagsFor(text).filter((flag) => /消化道出血/.test(flag)), [],
    `口语消化道出血不得越过 T6 直接取得硬红旗门权：${text}`,
  );
}

// 书面语 + 明确严重度证据，才是硬门档
assert.ok(
  redFlagsFor("黑便2天伴头晕乏力").some((flag) => /消化道出血/.test(flag)),
  "书面语「黑便2天伴头晕乏力」应触发消化道出血硬红旗",
);

// 误报防线
const GI_BLEED_MUST_NOT = [
  "大便干结2-3日一行，腹胀纳差",
  "大便偏黄成形，日一行",
  "胃脘隐痛3月。否认呕血，否认黑便，否认便血。",
];
for (const text of GI_BLEED_MUST_NOT) {
  assert.deepEqual(
    redFlagsFor(text).filter((flag) => /消化道出血/.test(flag)), [],
    `不得触发消化道出血红旗：${text}`,
  );
}
// 伴随症被整句否认时不得当成严重度证据（否则红旗会对着「无头晕乏力」乱响）
assert.deepEqual(
  redFlagsFor("服用铁剂后大便发黑，无头晕乏力，复查便潜血阴性").filter((flag) => /消化道出血/.test(flag)), [],
  "严重度伴随症被否认时不得判为活动性出血",
);
assert.ok(
  redFlagsFor("黑便2天，无呕血，伴头晕乏力").some((flag) => /消化道出血/.test(flag)),
  "否定只辖其中一项时，其余阳性伴随症仍应成立",
);

console.log("test-colloquial-redflag-coverage: OK", {
  stroke: STROKE_PHRASINGS.length,
  strokeNegative: STROKE_NOT_ACUTE.length,
  giBleedColloquialAdvisory: GI_BLEED_COLLOQUIAL.length,
  giBleedNegative: GI_BLEED_MUST_NOT.length,
});
