/**
 * Invariant: 中成药候选的排序与证据绑定都必须由**临床**信号决定。
 *
 * 甲方反馈是「西药/中成药候选，推荐的药都不太对」。逐层实测下来，召回本身是对的（心脾两虚型不寐
 * 召回的 10 条全是心脾两虚方），坏的是排序与绑定：
 *
 * 1) 非临床代理指标升格成了排序主键。原打分含一项 riskDetailScore——说明书的禁忌/注意/孕哺/
 *    相互作用四栏每填一栏 +0.05。本意是温和的 tie-breaker，但临床概念词表粒度粗、并列极常见：
 *    实测 10 条里 9 条完全并列 17.15，唯一区分项就是这 0.05。归脾丸出自宋《济生方》，现代说明书
 *    「禁忌」一栏写「尚不明确」，因此少算一栏、以 17.1 排在**最后**，输给了五味安神颗粒、
 *    参茯胶囊、灵芪加口服液这些冷门厂牌药。药典标准方被文档完整度挤掉。
 *
 * 2) 同方多剂型各占一个名额。归脾合剂／归脾液／归脾片／归脾丸 是同一基础方的四种剂型，
 *    实测吃掉 10 条候选中的 4 条，把真正不同的选择挤出列表。
 *
 * 3) 证据绑定跑在整行上。记录行是 `标签：值｜标签：值`，除适应证外还含「禁忌/注意」「特殊人群」
 *    「相互作用」。原实现的概念匹配与裸子串兜底都在整行上跑，于是**反指征条文可以证明适应证**：
 *    丁桂温胃散（适应证=温胃散寒，行气止痛；禁忌栏写「不适用于肝肾阴虚，主要表现为口干、
 *    手足心热、心烦易怒」）能以 correspondingProblem=肝肾阴虚／肾阴虚／手足心热 通过绑定校验，
 *    一个温里药被绑成「对应肝肾阴虚」，正好用反了。这是 fail-open，不是排序问题。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { retrieveLocalPatentMedicineCandidates } from "../src/lib/local-patent-medicine-candidates.ts";
import { buildEvidenceScope, medicineEvidenceBindingValid } from "../src/lib/evidence-source-validation.ts";

// ── 1) + 2) 排序与去重：心脾两虚型不寐 ────────────────────────────────────────
const heartSpleenInsomnia = {
  id: "patent_ranking", phase: "prescribe",
  patient: { sex: "女", age: 52 },
  chiefComplaint: "入睡困难、多梦易醒3个月，加重半个月",
  symptoms: {
    "失眠": "入睡需1-2小时，夜醒2-3次，多梦",
    "乏力": "白天疲倦",
    "食欲不振": "饭量减少，饭后脘腹胀",
    "心悸": "劳累后偶发",
    "健忘": "记忆力下降",
  },
  tongue: "舌淡，苔薄白", pulse: "细弱", faceNote: "面色萎黄，神疲",
  vitals: {}, pastHistory: "", medicationHistory: "", allergyHistory: "", conversation: [],
  reasoningDiagnose: {
    overview: { primarySyndrome: "心脾两虚证", primarySyndromeBasis: ["面色萎黄", "舌淡苔薄白", "脉细弱"] },
    westernDiagnosis: { primary: { name: "失眠障碍", supportingFacts: ["入睡困难3月余"] } },
    terminologyMappings: [],
  },
};

const candidates = retrieveLocalPatentMedicineCandidates(heartSpleenInsomnia, 10);
assert.ok(candidates.length > 0, "心脾两虚型不寐必须能召回中成药候选");

// 药典标准方必须排在同证冷门厂牌药之前。它此前因说明书「禁忌：尚不明确」少 0.05 分排在最后。
assert.equal(
  candidates[0].name,
  "归脾丸",
  `心脾两虚型不寐的首选中成药应是归脾丸，实得 ${candidates.map((item) => item.name).join("、")}`,
);

// 同方多剂型只保留一条：归脾合剂／归脾液／归脾片 不得与归脾丸同时出现。
const guipiForms = candidates.filter((item) => item.name.startsWith("归脾"));
assert.equal(
  guipiForms.length,
  1,
  `同一基础方的多种剂型必须去重，实得 ${guipiForms.map((item) => item.name).join("、")}`,
);

// 去重后的名额必须真的让位给不同的方，而不是空着。
assert.ok(candidates.length >= 8, `去重后应仍有足量候选，实得 ${candidates.length} 条`);
assert.equal(
  new Set(candidates.map((item) => item.name)).size,
  candidates.length,
  "候选列表内不得出现重复药名",
);

// 说明书文档完整度不得再参与排序：构造一个「文档更全但非经典方」的对照——
// 若它排在归脾丸之前，说明非临床代理指标又回到了排序里。
const documentationOnlyRivals = candidates.filter((item) => item.name !== "归脾丸");
for (const rival of documentationOnlyRivals) {
  assert.ok(
    candidates[0].score >= rival.score,
    `${rival.name} 不应排在药典标准方之前（分数 ${rival.score} vs 归脾丸 ${candidates[0].score}）`,
  );
}

// ── 3) 证据绑定：禁忌条文不得充当适应证证据 ──────────────────────────────────
const fingerprint = `sha256:${createHash("sha256").update("patent-binding-fixture").digest("hex")}`;
// 逐字照 buildLocalPatentMedicineContext 的行格式构造：一个温里药，禁忌栏写着「不适用于肝肾阴虚」。
const warmingMedicineRecord = [
  `- [LOCAL-INST-001] 药名：丁桂温胃散｜规格：每袋3g｜批准文号：国药准字Z00000000｜生产企业：某某药业`,
  `适应证：温胃散寒，行气止痛。用于寒性脘痛及寒性腹痛。`,
  `本例命中：胃脘痛｜事实：胃脘冷痛｜用法：口服，一次3g`,
  `禁忌/注意：孕妇忌服。不适用于脾胃阴虚，主要表现为口干、舌红少津；不适用于肝肾阴虚，主要表现为口干、手足心热、心烦易怒`,
  `特殊人群：儿童慎用｜相互作用：尚不明确｜条目指纹：${fingerprint}`,
].join("｜");
const scope = buildEvidenceScope(`【本地中成药说明书检索（病例绑定候选；不是自动处方）】\n${warmingMedicineRecord}`);
const bindingValid = (problem) =>
  medicineEvidenceBindingValid("LOCAL-INST-001", fingerprint, "丁桂温胃散", problem, "每袋3g", scope);

assert.equal(bindingValid("寒性脘痛"), true, "真适应证必须仍能通过绑定校验");
for (const contraindicationPhrase of ["肝肾阴虚", "肾阴虚", "手足心热", "脾胃阴虚", "舌红少津"]) {
  assert.equal(
    bindingValid(contraindicationPhrase),
    false,
    `禁忌条文「${contraindicationPhrase}」不得充当适应证证据——那会把一个温里药绑成「对应阴虚」`,
  );
}
assert.equal(bindingValid("糖尿病"), false, "完全无关的问题当然不通过");

// 没有适应证段的条目无法证明适应关系，一律不通过（fail-closed）。
const noIndicationRecord = `- [LOCAL-INST-002] 药名：某某丸｜规格：每袋3g｜禁忌/注意：孕妇忌服｜条目指纹：${fingerprint}`;
const noIndicationScope = buildEvidenceScope(`【本地中成药说明书检索】\n${noIndicationRecord}`);
assert.equal(
  medicineEvidenceBindingValid("LOCAL-INST-002", fingerprint, "某某丸", "失眠", "每袋3g", noIndicationScope),
  false,
  "不载明适应证的条目无法证明某药对某问题适用",
);

// ── 4) 寒热方向对立必须排除（甲方 2026-08-12 线上实测）───────────────────────────
//
// 实测：42 岁男性、已签名「风寒袭肺证」，候选 10 条里 6 条是清热方向——
// 泻白糖浆（宣肺清热）还排第 1，另有九味双解口服液、克感利咽口服液、凉解感冒合剂、
// 十味龙胆花胶囊、儿感清口服液。候选链此前三道过滤（临床概念命中 / 体质虚证前提 /
// 经方鉴别反证）**没有一道看寒热方向**，而这个判据仓库里早就有（formula-syndrome-consistency
// 的 guard 内核），只接了汤方通路——又一次同一判据只接了一个出口。
//
// 注：甲方点名的「云实感冒合剂」其说明书原文是「解表散寒…用于风寒感冒」，对风寒表证是**对证的**，
// 不该被排除；真正该排除的是上面那 6 条清热方。本用例两个方向都钉。
const windColdCough = {
  id: "patent_thermal", phase: "prescribe",
  patient: { sex: "男", age: 42 },
  chiefComplaint: "咳嗽3天",
  symptoms: { "现病史": "3天前受凉后出现咳嗽，咳白色稀薄痰，鼻塞流清涕，恶寒无汗，头身酸痛。" },
  tongue: "舌淡红，苔薄白", pulse: "脉浮紧", faceNote: "神清",
  vitals: {}, pastHistory: "", medicationHistory: "", allergyHistory: "", conversation: [],
  reasoningDiagnose: {
    overview: { primarySyndrome: "风寒袭肺证", primarySyndromeBasis: ["恶寒无汗", "痰白稀", "脉浮紧"] },
    westernDiagnosis: { primary: { name: "急性上呼吸道感染", supportingFacts: ["咳嗽3天"] } },
    terminologyMappings: [],
  },
};
const coldCandidates = retrieveLocalPatentMedicineCandidates(windColdCough, 10);
assert.ok(coldCandidates.length > 0, "风寒袭肺证必须能召回中成药候选");
for (const heatMedicine of ["泻白糖浆", "九味双解口服液", "克感利咽口服液", "凉解感冒合剂", "十味龙胆花胶囊"]) {
  assert.ok(
    !coldCandidates.some((item) => item.name === heatMedicine),
    `风寒证不得推荐清热方「${heatMedicine}」：${coldCandidates.map((item) => item.name).join("、")}`,
  );
}
// 对证的散寒方必须留下——排除权只能行使在方向相反的候选上。
assert.ok(
  coldCandidates.some((item) => item.name === "云实感冒合剂"),
  `散寒方不得被误排除：${coldCandidates.map((item) => item.name).join("、")}`,
);

// 反向：同一条判据在风热证上必须反过来——散寒方出局、清热方留下。
const windHeatCough = {
  ...windColdCough,
  reasoningDiagnose: {
    ...windColdCough.reasoningDiagnose,
    overview: { primarySyndrome: "风热犯肺证", primarySyndromeBasis: ["咽痛", "痰黄", "脉浮数"] },
  },
};
const heatCandidates = retrieveLocalPatentMedicineCandidates(windHeatCough, 10);
assert.ok(
  !heatCandidates.some((item) => item.name === "云实感冒合剂"),
  `风热证不得推荐散寒方：${heatCandidates.map((item) => item.name).join("、")}`,
);
assert.ok(
  heatCandidates.some((item) => ["泻白糖浆", "凉解感冒合剂", "克感利咽口服液"].includes(item.name)),
  `风热证应保留清热方：${heatCandidates.map((item) => item.name).join("、")}`,
);

// 弃权边界：拿不到已签名证候时一条都不许排除——数据缺口绝不当成「方向相反」。
const unsigned = {
  ...windColdCough,
  reasoningDiagnose: { ...windColdCough.reasoningDiagnose, overview: { primarySyndrome: "", primarySyndromeBasis: [] } },
};
assert.equal(
  retrieveLocalPatentMedicineCandidates(unsigned, 10).length,
  10,
  "没有已签名证候时寒热过滤必须整条弃权",
);

console.log(JSON.stringify({
  suite: "patent-medicine-ranking",
  topCandidate: candidates[0].name,
  candidateCount: candidates.length,
  failures: 0,
}, null, 2));
