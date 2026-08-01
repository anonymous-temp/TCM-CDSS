/**
 * Invariant: 已经录入的事实不得被系统判成「未记录」。
 *
 * 这条不变量看起来是废话，实测却被两个各自独立的机制破坏，而且方向一致——都是**把医生录进去的
 * 东西判丢**，然后在给医生看的结论里写「病历尚未确认X是否存在」「脉象待核实」。同一份公开医案
 * 跑出来的 M03 里两种都出现了：
 *
 *   辨病推理：「病历尚未确认入睡困难是否存在；但睡眠障碍为突出表现，故归入不寐」——主诉就是失眠
 *   辨证推理：「月经量少推迟、脉象待核实为血虚」——医生录的是「脉细弦无力」
 *
 * 两处根因不同，但错法同类：**判定用的信号比事实实际存在的范围窄**。
 *
 * 1) 接地语料把 state.symptoms 整体排除。排除的理由是真的（M01 collect 可能把「否认胸痛」误读成
 *    阳性症状），但触发条件写成了「存在 HIS 记录或对话」——医生答完一条 M02 追问就会命中，
 *    于是他之前录入的全部症状一起出局。危险的是「模型衍生」，不是「有对话」。
 * 2) 脉象具体性判定的右边界要求整段在标点处收住，而脉力词（无力/有力）不在脉象词表里。
 *    「脉细弦无力」这种最常见的写法因此判为未记录——多写一个词，接地反而更差。
 *
 * 失效方向很重要：漏掉一个来源，对红旗判定是保守的（顶多漏掉一个模型幻觉），对接地判定却是
 * 反向的（凭空制造一个「未知」）。所以两者不能共用同一份语料，本文件同时锁住这一点。
 */
import assert from "node:assert/strict";
import {
  clinicalGroundingText,
  sanitizeUngroundedRedFlagNegations,
  trustedInputText,
} from "../src/lib/diagnosis-safety.ts";
import { isUnknownClinicalFieldText } from "../src/lib/clinical-state.ts";

function caseOf(overrides) {
  return {
    id: "t", phase: "diagnose", patient: { sex: "女", age: 40 },
    chiefComplaint: "睡不着三年多了", symptoms: {}, tongue: "", pulse: "", faceNote: "",
    vitals: {}, pastHistory: "", medicationHistory: "", allergyHistory: "",
    conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
    ...overrides,
  };
}

// ── 1) M02 追问产生对话后，医生此前录入的症状仍然算「已记录」──────────────────
const afterFollowup = caseOf({
  symptoms: { sleep: "入睡困难，多梦易醒", other: "心悸气短" },
  conversation: [
    { role: "assistant", content: "问题1：睡眠情况持续多久？" },
    { role: "user", content: "三年多了。舌质暗有瘀点。" },
  ],
});
assert.ok(
  clinicalGroundingText(afterFollowup).includes("入睡困难"),
  "医生答完一条追问，不得让他之前录入的症状从接地语料里消失",
);
assert.ok(
  clinicalGroundingText(afterFollowup).includes("心悸气短"),
  "同一字段的其余条目同样不得消失",
);
assert.equal(
  sanitizeUngroundedRedFlagNegations("患者入睡困难，病程三年", afterFollowup),
  "患者入睡困难，病程三年",
  "已录入的症状不得被改写成「病历尚未确认…是否存在」",
);

// ── 2) 但极性反转仍然挡得住：collect 误把否认读成阳性 ────────────────────────
// 这是当初把 symptoms 排除在外的唯一真实理由，放宽接地语料不得把它一起放掉。
const polarityInverted = caseOf({
  chiefComplaint: "突发晕厥1次",
  symptoms: { pain: "胸痛" },
  conversation: [{ role: "user", content: "否认胸痛，但突发晕厥一次。" }],
});
assert.ok(
  !clinicalGroundingText(polarityInverted).split("\n").includes("胸痛"),
  "权威文本已明确否认的症状，不得因为出现在模型衍生的 symptoms 里就算已记录",
);
assert.match(
  sanitizeUngroundedRedFlagNegations("患者胸痛明显", polarityInverted),
  /尚未确认胸痛/,
  "被否认的症状被写成阳性时，净化器仍须拦下",
);

// ── 3) 红旗语料与接地语料必须分开：失效方向相反 ──────────────────────────────
// trustedInputText 是安全判定用的保守语料，不得因为本次放宽而把模型衍生字段吸进去。
assert.ok(
  !trustedInputText(afterFollowup).includes("入睡困难"),
  "安全语料仍然排除模型衍生的 symptoms——这条是红旗侧的保守性，未被放宽",
);
assert.notEqual(
  trustedInputText(afterFollowup),
  clinicalGroundingText(afterFollowup),
  "两份语料必须真的不同；若被人合并回一份，本不变量就失去意义",
);

// ── 4) 脉象：常规写法必须判为已记录，脉力词不得让整条脉象失效 ────────────────
const recordedPulses = [
  "脉细弦无力", "脉沉细无力", "脉弱无力", "脉弦细有力", "脉细弦", "脉沉细",
  "脉弦滑数", "舌质暗有瘀点，苔薄白腻，脉细弦无力。", "脉细弦无力，舌淡",
  // 二十八脉里此前缺失的那几个：散、芤、革、牢、伏、动、长、短。
  "脉散", "脉芤", "脉革", "脉牢", "脉伏", "脉动数", "脉长", "脉短",
];
for (const text of recordedPulses) {
  assert.ok(
    !isUnknownClinicalFieldText(text, "pulse"),
    `「${text}」是一条真实的脉象记录，不得判为未记录`,
  );
}

// 反向：真的没有脉象时仍须判为未记录，否则这条门禁形同虚设。
for (const text of ["没测脉", "脉象待核实", "脉象未采集", "患者诉乏力", "脉象未知"]) {
  assert.ok(
    isUnknownClinicalFieldText(text, "pulse"),
    `「${text}」没有具体脉象，必须仍判为未记录`,
  );
}
// 先写具体脉象、后写待核实，以后者为准（原有的「就近取值」语义不得被本次改动破坏）。
assert.ok(
  isUnknownClinicalFieldText("脉细弦无力；复诊时脉象待核实", "pulse"),
  "同一段里后出现的「待核实」应覆盖先前的具体脉象",
);

// ── 5) 脉象词表只能有一份 ────────────────────────────────────────────────────
// 此前 6 处各抄一遍并已分叉：clinical-entry 收了二十八脉，其余五处只有 18 个。
// 同一个「这是不是脉象」的判断在不同环节给出不同答案，正是上面第 4 组用例的温床。
import { readFileSync } from "node:fs";
// 权威常量本身就以这 18 个字开头（后面接 散|芤|革|牢|伏|动|长|短|疾），所以不能只查「有没有」，
// 要查「出现几次、在哪一行」：声明处允许一次，其余任何地方出现都是又抄了一份。
const LEGACY_INLINE_VOCABULARY = "浮|沉|迟|数|滑|涩|弦|细|弱|濡|缓|紧|实|虚|微|洪|结|代|促";
const canonicalSource = readFileSync(new URL("../src/lib/clinical-state.ts", import.meta.url), "utf8");
const canonicalOccurrences = canonicalSource.split(LEGACY_INLINE_VOCABULARY).length - 1;
assert.equal(
  canonicalOccurrences, 1,
  `clinical-state.ts 里脉象词表出现了 ${canonicalOccurrences} 次，应当只有 PULSE_QUALITY_PATTERN_SOURCE 一处声明`,
);
assert.match(
  canonicalSource,
  new RegExp(`export const PULSE_QUALITY_PATTERN_SOURCE\\s*=\\s*\\n?\\s*"${LEGACY_INLINE_VOCABULARY.replace(/\|/g, "\\|")}`),
  "唯一那次出现必须是 PULSE_QUALITY_PATTERN_SOURCE 的声明本身",
);
for (const file of [
  "src/lib/clinical-entry.ts",
  "src/lib/diagnosis-safety.ts",
  "src/lib/diagnosis-stage-contract.ts",
  "src/app/diagnosis/DiagnosisClient.tsx",
]) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  assert.ok(
    !source.includes(LEGACY_INLINE_VOCABULARY),
    `${file} 又内联了一份脉象词表——请改用 clinical-state 导出的 PULSE_QUALITY_PATTERN_SOURCE`,
  );
}

console.log(JSON.stringify({
  suite: "recorded-fact-visibility",
  pulseFormsChecked: recordedPulses.length,
  failures: 0,
}, null, 2));
