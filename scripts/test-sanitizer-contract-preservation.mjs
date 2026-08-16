/**
 * 净化器的子句边界只认句号分号、不认逗号——一处否定会连坐同句内的真实临床内容。
 *
 * 【线上实证】2026-08-16 表里·阳明气分热盛案，同一份内容变换前后各算一次安全码：
 *   preTransformSafetyCode: '(none)'                        ← 变换前硬安全合同通过
 *   governingSafetyCode:    'overall_pathogenesis_unstable' ← 变换后不通过
 *   pathogenesisShape: { preLength: 69, postLength: 72, preUnstable: false, postUnstable: true }
 * 于是整份 M03 被当成「模型输出不合格」丢弃，医生看到「当前证候依据不足以形成稳定结论」空白页。
 *
 * 【本地复现出的精确机制】
 *   前: 热邪炽盛，未见黑便，未见呕血，热盛迫津
 *   后: 病历尚未确认呕血是否存在；病历尚未确认黑便是否存在
 * 「热邪炽盛」「热盛迫津」整段消失。根因在子句切分：
 *   line.replace(/[^。；;]+/g, sanitizeClause)
 * 只按句号/分号切，**不按逗号切**。整个逗号长句被当成一个子句，
 * 否定分支命中后返回术语列表替换**整句**，同句内的真实病机内容一并丢弃。
 *
 * 【两件事必须分开，别再连起来】
 * 我一度写成「丢内容 ⇒ 判不稳定 ⇒ 整页作废」一条完整因果链，被本套件当场证否：
 * 净化后的「病历尚未确认呕血是否存在；病历尚未确认黑便是否存在」实测仍判**稳定**。
 * 所以：
 *   · 线上 preUnstable:false → postUnstable:true 是真的，但成因**尚未定位**
 *     （变换链是 buildEvidenceOutputTransform(证据上下文, 净化器 + 安全横幅) 三层，净化器只是中间一层）；
 *   · 净化器丢内容也是真的，但它是**另一个独立缺陷**。
 * 下一步定位手段：在 finalized M03 rejected 日志里补一条命中的 marker 片段
 * （只是对冲词，不含临床内容），一次即可确定是哪一层加的那 3 个字。
 *
 * 【修法】子句边界加入逗号（两处：普通行与表格单元格同步）。同一输入变为
 *   热邪炽盛，病历尚未确认黑便是否存在，病历尚未确认呕血是否存在，热盛迫津
 * 未接地否定照样被改写（安全要求不变），真实病机保住。
 * 这个改动会重排净化器的作用粒度，风险由全量闸门判定而不是由我判断——
 * 实测归档态与 fresh 态两态全绿（除本套件那条「已知缺陷」断言按预期变红，已翻成正向）。
 *
 * 【走过的弯路，留给下一个人】第一版修法是「把 overallPathogenesis / primarySyndrome /
 * overallMethod 加进既有豁免名单」（那份名单已有 name / supportingFacts / primarySyndromeBasis /
 * patientFact / syndromeEvidence，注释写着同样的理由）。反证当场推翻：撤掉豁免套件依然绿——
 * 因为夹具里的病机不含未接地否定式，压根没触发净化。补上含否定式的夹具才复现。
 * 而复现之后可以看出，豁免是钝器：它会把没接地的「未见黑便」原样留给医生看，那是虚假安心。
 * **真正该修的是「别把同句内的其他内容一起丢掉」，不是「别碰这个字段」。**
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
const { sanitizeUngroundedRedFlagNegations } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { isUnstableM03CoreText } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");

const STATE = {
  id: "sanitizer-contract", phase: "diagnose",
  patient: { sex: "女", age: 45 },
  chiefComplaint: "发热3天",
  symptoms: { general: "壮热不恶寒反恶热，大汗出，大渴引饮，面赤心烦", tcmFourExams: "舌质红苔黄燥；脉洪大" },
  tongue: "舌质红，苔黄燥", pulse: "脉洪大",
  vitals: "T39.2 P104 R22 BP118/74",
  pastHistory: "既往体健", medicationHistory: "否认长期用药", allergyHistory: "否认药物食物过敏史",
  questionRounds: 1, maxQuestionRounds: 1, conversation: [],
  diagnosis: "", prescription: "", riskAssessment: "",
};

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";

function roundTrip(payload) {
  const content = `## 结论\n\n${START}\n${JSON.stringify(payload, null, 2)}\n${END}\n`;
  const sanitized = sanitizeUngroundedRedFlagNegations(content, STATE);
  const start = sanitized.lastIndexOf(START);
  const end = sanitized.indexOf(END, start);
  assert.ok(start >= 0 && end > start, "净化后必须仍能取回结构化载荷");
  return JSON.parse(sanitized.slice(start + START.length, end).trim());
}

// ── 2. 已知缺陷：一处未接地否定连坐同句真实内容 ────────────────────────────
// 钉的是**当前行为**，不是期望行为。变红说明净化器被改动——
// 请确认改的方向是「保留同句内的非否定部分」，而不是放宽否定式检测。
{
  const withUngroundedNegation = "热邪炽盛，未见黑便，未见呕血，热盛迫津";
  assert.ok(
    !isUnstableM03CoreText(withUngroundedNegation),
    "夹具前提：原文本身是稳定病机（有『热邪炽盛』『热盛迫津』两个临床锚点）",
  );
  const out = roundTrip({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "阳明气分热盛证", overallPathogenesis: withUngroundedNegation },
  });
  const after = out.overview.overallPathogenesis;
  assert.notEqual(after, withUngroundedNegation, "未接地的『未见黑便/未见呕血』必须被净化——这条是安全要求，不得取消");
  // 修复后的正向断言：净化未接地否定，同时**保住同句内的真实病机**。
  assert.ok(
    after.includes("热邪炽盛") && after.includes("热盛迫津"),
    "净化未接地否定时不得连坐同句内已接地的临床结论。"
    + `期望保留『热邪炽盛』与『热盛迫津』，实得：${after}`,
  );
  assert.ok(
    after.includes("病历尚未确认") && !after.includes("未见黑便") && !after.includes("未见呕血"),
    `未接地的『未见黑便/未见呕血』仍必须被改写——这条是安全要求，修子句边界不得把它一起放掉。实得：${after}`,
  );
  // 修复后仍判稳定——但要说清：**修复前它也判稳定**。
  // 「净化器丢内容 ⇒ 判不稳定 ⇒ 整页作废」曾被我当成一条完整因果链，被本套件当场证否：
  // 丢内容后的纯对冲文本实测仍判稳定。所以线上那次 preUnstable:false → postUnstable:true
  // 是**另一个**变换环节造成的，与本条无因果，仍待定位（变换链共三层，净化器只是中间一层）。
  assert.ok(
    !isUnstableM03CoreText(after),
    "净化后的病机必须仍是稳定结论——修复的意义正在于保住临床锚点",
  );
}

// ── 2b. 不含未接地否定的稳定病机不得被改动 ─────────────────────────────────
const STABLE_PATHOGENESES = [
  "外邪入里化热，热炽阳明气分，津液耗伤，胃热炽盛，腑气未结，热盛迫津外泄",
  "肝气郁结，横逆犯胃，胃失和降，气机壅滞",
  "脾胃虚寒，中阳不振，寒凝气滞，运化失司",
  "肾阴亏虚，虚火内扰，水不涵木，肝阳偏亢",
];
for (const pathogenesis of STABLE_PATHOGENESES) {
  assert.ok(!isUnstableM03CoreText(pathogenesis), `夹具前提：${pathogenesis} 必须是稳定结论`);
  const out = roundTrip({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "阳明气分热盛证", overallPathogenesis: pathogenesis },
  });
  assert.equal(
    out.overview.overallPathogenesis, pathogenesis,
    `不含未接地否定的病机必须逐字保持：${pathogenesis}`,
  );
}

// ── 3. 豁免不得外溢：接地断言字段仍须照常净化 ──────────────────────────────
// 病历里根本没提「呕血」，模型却写「否认呕血」——这类没有接地的否定式必须被改写。
// 若这条变绿失败（即接地字段也被豁免了），说明豁免范围放宽过头，安全净化被架空。
{
  const out = roundTrip({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: {
      primarySyndrome: "阳明气分热盛证",
      overallPathogenesis: "外邪入里化热，热炽阳明气分",
      uncertainties: [{ item: "否认呕血", reason: "否认呕血", affects: "中医证候" }],
    },
  });
  const row = out.overview.uncertainties?.[0];
  assert.ok(row, "接地字段不应被整条删除");
  assert.notEqual(
    row.reason, "否认呕血",
    "没有接地的红旗否定式必须仍被净化改写——豁免只针对结论字段，不得外溢到断言字段",
  );
}

// ── 4. 幂等：净化两次与一次结果一致 ────────────────────────────────────────
// 非幂等会让签名前的第二遍净化改动字节，从而作废一份已被接受的独立复核（本仓既有纪律）。
{
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "阳明气分热盛证", overallPathogenesis: "外邪入里化热，热炽阳明气分，津液耗伤" },
  };
  assert.deepEqual(roundTrip(roundTrip(payload)), roundTrip(payload), "净化必须幂等");
}

console.log("test-sanitizer-contract-preservation: OK", {
  stablePathogeneses: STABLE_PATHOGENESES.length,
});
