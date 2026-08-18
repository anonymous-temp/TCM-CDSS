/**
 * Invariant: 按模块顺序反馈可以做，但不得退回到「在验证前流式输出第二份临床正文」。
 *
 * 需求2 要「推理时按模块顺序执行，一个模块一个模块来，而不是最后统一出」。这与代码里一条既有
 * 决策直接相邻——diagnosis-api.ts 把全部结构化阶段设为 bufferedClinicalStage，注释写明理由：
 *   "Streaming a second, provisional representation before the authoritative JSON is validated
 *    caused visible/structured drift and could expose raw internal fields."
 * 这个项目试过流式输出临时临床正文，出过事才改成缓冲。
 *
 * 因此实现取的是两者之间那条窄路：**只推模块完成信号 + 该模块的结论标题**，字段走白名单，
 * 完整正文仍然只在末尾由 STREAM_REPLACE_MARKER 一次性确定性渲染（该标记会把之前推送的内容
 * 整段丢弃，见 diagnosis-engine 的 `combined.slice(markerIdx + marker.length)`）。
 *
 * 本文件锁三件事：模块确实按顺序逐个落地；标题只来自白名单字段；未登记模块默认不上流。
 * 最后一条是「不泄漏原始内部字段」这条约束的落点——默认不暴露，新增模块必须显式登记。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  completedTopLevelKeys,
  moduleProgressNotice,
  newModuleNotices,
} from "../src/lib/diagnosis-stream-modules.ts";
import {
  m03ModuleDraftFrame,
  newM03ModuleDraftFrames,
} from "../src/lib/diagnosis-stream-module-drafts.ts";

const M03_PAYLOAD = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "不寐",
    primarySyndrome: "心脾两虚证",
    primarySyndromeBasis: ["面色萎黄", "舌淡苔薄白"],
    // 内部字段：绝不能出现在可见流里。
    primarySyndromeResolutionReason: "缺少腰膝酸软等定位证据",
  },
  westernDiagnosis: {
    primary: { name: "失眠障碍", supportingFacts: ["入睡困难3月余"], clinicalRationale: "病程符合慢性失眠" },
    differentials: [],
  },
  pathogenesis: {
    summary: "心脾两虚，心神失养",
    chain: [
      { nodeId: "P1", patientFact: "入睡困难3月余", syndromeEvidence: "入睡困难", pathogenesis: "心血不足，心神失养", therapyDirection: "养血安神" },
      { nodeId: "P2", patientFact: "面色萎黄", syndromeEvidence: "面色萎黄", pathogenesis: "脾气不足，化源不充", therapyDirection: "健脾益气" },
    ],
    uncertainties: [],
  },
  therapy: {
    overallPrinciple: "虚则补之",
    overallMethod: "补益心脾，养血安神",
    subTherapies: [
      { targetPathogenesis: "心血不足，心神失养", method: "养血安神", priority: "primary" },
      { targetPathogenesis: "脾气不足，化源不充", method: "健脾益气", priority: "secondary" },
    ],
  },
  formula: null,
  nonPharma: { diet: "清淡饮食", lifestyle: "规律作息", emotion: "调畅情志" },
  management: { followupSafetyNet: "症状加重时复诊" },
};

// ── 1) 模块按顺序逐个落地，而不是最后一次性出 ────────────────────────────────
const serialized = JSON.stringify(M03_PAYLOAD);
const emitted = new Set();
const timeline = [];
for (let cursor = 40; ; cursor += 40) {
  const partial = serialized.slice(0, Math.min(cursor, serialized.length));
  for (const notice of newModuleNotices(partial, emitted)) {
    timeline.push({ atChars: partial.length, notice });
  }
  if (cursor >= serialized.length) break; // 最后一片必须扫到，否则末尾模块被漏判
}
// 7 个已登记模块，M03 阶段 formula 恒为 null 不上流 ⇒ 恰好 6 条。写死数字而不是 >=，
// 这样「悄悄多推一个模块」和「悄悄少推一个模块」都会失败。
assert.equal(
  timeline.length,
  6,
  `模块应逐个落地且恰好 6 条，实得 ${timeline.length}：${timeline.map((item) => item.notice).join(" | ")}`,
);
assert.ok(
  timeline[0].atChars < serialized.length,
  "第一个模块必须在整份 JSON 写完之前就上流——否则等于没有按模块反馈",
);
assert.ok(
  timeline.every((item, index) => index === 0 || item.atChars >= timeline[index - 1].atChars),
  "模块反馈必须按写完顺序推送",
);
const noticeText = timeline.map((item) => item.notice).join("\n");
// ── 定型前的流里不得出现临床结论文本（2026-08-11 线上实测）───────────────────────
//
// 原断言逐字要求进度行写出「辨证 心脾两虚证」「失眠障碍」「补益心脾，养血安神」。
// 甲方实测证明这恰恰是缺陷：这些是**第一稿未校验草稿**，而合同校验 → 独立复核 →
// 最多 4 轮重生成全在流结束之后，复核完全可能把「心脾两虚证」改写成「心神失养证」——
// 医生在同一屏里先后看到两个证候，无从判断哪个作数。
// 现在这四个模块只推完成信号；「按模块顺序反馈」（需求2）由下面的条数与顺序断言继续保证。
assert.match(noticeText, /中医辨病辨证：已生成，待结构校验与独立复核/);
assert.match(noticeText, /西医诊断：已生成，待结构校验与独立复核/);
assert.match(noticeText, /病机分析：已形成 2 个病机节点/);
assert.match(noticeText, /治则治法：已生成，待结构校验与独立复核/);
// 会被修复轮改写的结论文本一个都不许出现在定型前的流里。
for (const volatileConclusion of ["心脾两虚证", "失眠障碍", "补益心脾", "不寐"]) {
  assert.ok(!noticeText.includes(volatileConclusion),
    `定型前的进度行不得出现会被复核改写的结论：${volatileConclusion}`);
}

// ── 2) 只暴露白名单结论标题，不泄漏内部字段 ──────────────────────────────────
for (const internalFragment of [
  "primarySyndromeResolutionReason",
  "缺少腰膝酸软",
  "clinicalRationale",
  "病程符合慢性失眠",
  "supportingFacts",
  "入睡困难3月余",
  "schemaVersion",
  "tcm-cdss-reasoning-v2",
  "nodeId",
  "uncertainties",
]) {
  assert.ok(
    !noticeText.includes(internalFragment),
    `可见流泄漏了内部字段或未登记内容：${internalFragment}`,
  );
}

// ── 3) 未登记模块默认不上流（default-deny）────────────────────────────────────
const withUnknownModule = JSON.stringify({
  ...M03_PAYLOAD,
  internalAudit: { rawPromptFingerprint: "sha256:deadbeef", reviewerNotes: "不得外泄" },
});
const unknownEmitted = new Set();
const unknownNotices = newModuleNotices(withUnknownModule, unknownEmitted).join("\n");
assert.ok(unknownEmitted.has("internalAudit"), "扫描器应识别到该顶层键（否则本用例无意义）");
assert.ok(
  !unknownNotices.includes("internalAudit") && !unknownNotices.includes("deadbeef") && !unknownNotices.includes("不得外泄"),
  "未登记的模块必须默认不上流——新增模块要显式登记它暴露哪个字段",
);

// M03 阶段 formula 恒为 null，不应产出候选方药的进度行。
assert.equal(moduleProgressNotice(serialized, "formula"), undefined, "值为 null 的模块不上流");

// ── 4) M04 的候选方药只报方名与味数，不报药名剂量 ────────────────────────────
const m04Payload = JSON.stringify({
  stage: "prescribe",
  formula: {
    candidates: [{
      name: "归脾汤加减",
      herbs: [
        { name: "党参", dose: "12g" },
        { name: "白术", dose: "10g" },
        { name: "茯苓", dose: "12g" },
      ],
    }],
  },
});
const m04Notice = moduleProgressNotice(m04Payload, "formula") || "";
// 方名同样会被下游改写（剥名与恢复身份两条路径都可能改它），与证候名同一类，定型前不报。
assert.ok(!m04Notice.includes("归脾汤"), "定型前不得报方名——方名会被剥名/恢复身份改写");
assert.match(m04Notice, /共 3 味/, "可以报味数");
for (const forbidden of ["党参", "12g", "白术", "茯苓"]) {
  assert.ok(!m04Notice.includes(forbidden), `进度行不得出现药名或剂量：${forbidden}（剂量要等审方，组成要等核验）`);
}

// ── 5) 通过片段合同后才产生类型化临床草稿帧 ────────────────────────────────
const draftFrames = newM03ModuleDraftFrames(serialized, new Set());
assert.deepEqual(
  draftFrames.map((frame) => frame.module),
  ["m03.syndrome", "m03.western", "m03.pathogenesis", "m03.therapy"],
  "M03 草稿帧必须按顶层模块闭合顺序产生，UI 再按固定临床顺序展示",
);
const draftText = draftFrames.map((frame) => frame.content).join("\n");
assert.ok(draftFrames.every((frame) => frame.type === "module_draft" && frame.revision === 1));
assert.match(draftText, /生成中 · 未定稿/);
assert.match(draftText, /心脾两虚证/);
assert.match(draftText, /失眠障碍/);
assert.match(draftText, /心血不足，心神失养/);
assert.match(draftText, /补益心脾，养血安神/);
for (const forbidden of [
  "primarySyndromeResolutionReason",
  "clinicalRationale",
  "guidelineReferences",
  "evidence",
  "DOI",
  "PMID",
  "http://",
  "审方结论",
  "contractSignature",
  "attestation",
  "reasonCode",
]) {
  assert.ok(!draftText.includes(forbidden), `模块草稿不得泄漏禁区内容：${forbidden}`);
}

const invalidWestern = JSON.stringify({
  westernDiagnosis: { primary: { name: "失眠障碍", supportingFacts: [] }, differentials: [] },
});
assert.equal(m03ModuleDraftFrame(invalidWestern, "westernDiagnosis"), undefined, "西医片段缺少支持事实不得上流");

const invalidPathogenesis = JSON.stringify({
  pathogenesis: { summary: "心神失养", chain: [], uncertainties: [] },
});
assert.equal(m03ModuleDraftFrame(invalidPathogenesis, "pathogenesis"), undefined, "空病机链不得上流");

const doseBearingPathogenesis = JSON.stringify({
  pathogenesis: {
    summary: "心神失养",
    chain: [{
      patientFact: "曾服酸枣仁12g",
      syndromeEvidence: "入睡困难",
      pathogenesis: "心神失养",
      therapyDirection: "养血安神",
    }],
  },
});
assert.equal(m03ModuleDraftFrame(doseBearingPathogenesis, "pathogenesis"), undefined, "含药物剂量的草稿不得上流");

const chineseDoseBearingPathogenesis = doseBearingPathogenesis.replace("12g", "12克");
assert.equal(m03ModuleDraftFrame(chineseDoseBearingPathogenesis, "pathogenesis"), undefined, "中文剂量单位同样不得上流");

const verdictBearingOverview = JSON.stringify({
  overview: { primarySyndrome: "安全总评通过", primarySyndromeBasis: ["入睡困难"] },
});
assert.equal(m03ModuleDraftFrame(verdictBearingOverview, "overview"), undefined, "含安全 verdict 的草稿不得上流");

const referenceBearingWestern = JSON.stringify({
  westernDiagnosis: {
    primary: {
      name: "失眠障碍",
      supportingFacts: ["入睡困难3月余"],
      guidelineReferences: [{ citation: "伪造指南 DOI:10.1/example", url: "http://example.com" }],
    },
    differentials: [],
  },
});
const referenceSafeFrame = m03ModuleDraftFrame(referenceBearingWestern, "westernDiagnosis");
assert.ok(referenceSafeFrame, "引用字段应被白名单投影丢弃，不应连坐合法西医片段");
assert.ok(!/DOI|http:\/\//.test(referenceSafeFrame.content), "引用与 URL 不得进入草稿帧");

// ── 6) 截断的 JSON 不得误报未写完的模块 ──────────────────────────────────────
const truncated = serialized.slice(0, serialized.indexOf('"pathogenesis"') + 30);
assert.ok(
  !completedTopLevelKeys(truncated).includes("pathogenesis"),
  "值尚未闭合的模块不得被判为已写完",
);

// ── 7) 结构化阶段仍是缓冲的，权威正文只出一次 ──────────────────────────────
const apiSource = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
assert.match(
  apiSource,
  /const bufferedClinicalStage = opts\.structuredStage != null/,
  "结构化阶段必须仍然缓冲：模块草稿是独立辅助帧，权威终稿不得改回原始正文直出",
);
assert.match(
  apiSource,
  /enqModuleDraft\(ctrl, parsed\)/,
  "模块草稿必须走独立 NDJSON 帧，不能伪装成普通 content",
);
assert.match(
  apiSource,
  /newM03ModuleDraftFrames\(/,
  "服务端必须调用片段合同投影器，而不是直出模型原始 JSON",
);
assert.match(
  apiSource,
  /m03WesternHalfPromise\?\.then/s,
  "并行西医半完成时必须能在整份 M03 终稿之前发出西医模块",
);
assert.match(
  apiSource,
  /opts\.structuredStage === "diagnose"[\s\S]{0,500}newM03ModuleDraftFrames/,
  "临床草稿帧本包只能在 M03 分支发出，M04 药味剂量继续保持缓冲",
);

console.log(JSON.stringify({
  suite: "stream-modules",
  moduleNotices: timeline.length,
  firstNoticeAtChars: timeline[0].atChars,
  totalChars: serialized.length,
  failures: 0,
}, null, 2));
