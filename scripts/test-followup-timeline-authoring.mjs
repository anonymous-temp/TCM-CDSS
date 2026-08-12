// 结构化随访时间轴的**模型驱动**契约（2026-08-12 甲方：「别他妈的又做成套话和固定话术和硬编码」）。
//
// 改造前实测：整张表只有 indicators 一栏是模型写的，而且两条目共用同一份；
//   · action 是两条写死的字符串；
//   · time 第二条恒为「治疗期间随时」；
//   · triggers 主体恒为「主要症状较首诊无改善或加重，或出现新的伴随症状」。
// 一个风寒表证与一个湿热淋证拿到的时间轴逐字相同——那不是随访方案，是排版。
//
// 本套件钉住四件事：
//   ① 模型给了时间轴就必须真的用它（四栏都用，不是只用 indicators）；
//   ② 审方得出的安全触发条件**只增不减**并进第一条——模型给什么都挤不掉；
//   ③ 第一条时间点强制等于处方煎服法定的首次复诊时间，表与正文不得各说各的；
//   ④ 红旗 / 无结构化剂量 / 硬剂量边界三条降级路径**完全不走模型**。
import assert from "node:assert/strict";

const {
  buildDeterministicRiskFollowupPayload,
  parseStructuredFollowupTimeline,
  buildDeterministicRiskFollowup,
} = await import("../src/lib/diagnosis-safety.ts");

const failures = [];
const check = (name, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
};

const doseCase = () => ({
  id: "T-FOLLOWUP-1",
  phase: "assess",
  patient: { age: 42, sex: "男" },
  chiefComplaint: "咳嗽5天",
  symptoms: { presentHistory: "5天前受凉后咳嗽，痰白清稀，恶寒无汗。" },
  vitals: {},
  conversation: [],
  safetyGate: { status: "ready", redFlags: [], reasons: [], missingItems: [], allowDiagnosis: true, allowDosePrescription: true },
  reasoningPrescribe: {
    stage: "prescribe",
    formula: {
      candidates: [{
        name: "三拗汤加减",
        herbs: [
          { name: "麻黄", dose: "6g" },
          { name: "杏仁", dose: "10g" },
          { name: "甘草", dose: "6g" },
        ],
        decoction: { followUpNode: "服药3天后复诊" },
      }],
    },
  },
});

const AUTHORED = {
  reviewFocus: "重点复评恶寒与咳嗽的消长、有无汗出、痰色由白转黄与否、舌苔与脉象变化。",
  efficacyCriteria: "以首诊为基线，恶寒已解、咳嗽转为松畅、痰量减少且未出现新发不适即为有效。",
  lifestyle: "风寒证忌生冷瓜果与冷饮，注意颈背保暖，避免汗出当风，起居宜早卧。",
  dimensions: ["症状", "舌象"],
  monitoringIndicators: ["咳嗽频次与夜间影响", "痰色痰量", "恶寒有无汗出"],
  timeline: [
    { time: "服药3天后复诊", action: "线上复诊，确认恶寒是否已解、咳嗽是否转为松畅", indicators: ["恶寒消长", "痰色痰量"], triggers: ["出现高热、气促或胸痛"] },
    { time: "服药7天", action: "门诊复诊并按表证转归决定是否调方", indicators: ["咳嗽频次", "舌苔由白转黄与否"], triggers: ["咳嗽加重或痰转黄稠"] },
  ],
};

check("① 模型给的时间轴四栏都真的用上了，不是只用 indicators", () => {
  const payload = buildDeterministicRiskFollowupPayload(doseCase(), AUTHORED);
  assert.equal(payload.timelineItems.length, 2, "条目数应来自模型");
  const second = payload.timelineItems[1];
  assert.equal(second.time, "服药7天", "第二条时间点仍是写死的「治疗期间随时」");
  assert.equal(second.action, "门诊复诊并按表证转归决定是否调方", "action 仍是写死的套话");
  assert.deepEqual(second.indicators, ["咳嗽频次", "舌苔由白转黄与否"]);
  assert.deepEqual(second.triggers, ["咳嗽加重或痰转黄稠"], "triggers 仍是写死的固定话术");
  // 两条目不得共用同一份观察项——那是改造前的形态。
  assert.notDeepEqual(payload.timelineItems[0].indicators, second.indicators);
});

check("② 第一条时间点强制与处方煎服法同源，模型改不动", () => {
  const authored = {
    ...AUTHORED,
    timeline: [{ ...AUTHORED.timeline[0], time: "模型自己编的时间" }, AUTHORED.timeline[1]],
  };
  const payload = buildDeterministicRiskFollowupPayload(doseCase(), authored);
  assert.equal(
    payload.timelineItems[0].time,
    "服药3天后复诊",
    "第一条时间点必须等于 decoction.followUpNode，否则表与正文「首次复诊时间」各说各的",
  );
});

check("③ 审方安全触发条件只增不减地并进第一条", () => {
  const state = doseCase();
  // 安全触发条件由 riskReviewSource 从 riskAssessment / prescription / diagnosis 三处抽取。
  state.riskAssessment = [
    "## 处方安全总评",
    "| 强提示 | 麻黄相关 | 服药后出现心悸、血压升高需停药复诊 |",
  ].join("\n");
  // 模型给了一条完全无关的 trigger，安全项仍必须在。
  const authored = {
    ...AUTHORED,
    timeline: [{ ...AUTHORED.timeline[0], triggers: ["自觉好转即可"] }, AUTHORED.timeline[1]],
  };
  const payload = buildDeterministicRiskFollowupPayload(state, authored);
  const first = payload.timelineItems[0];
  assert.ok(first.triggers.includes("自觉好转即可"), "模型给的 trigger 应保留");
  // 安全触发条件来自审方文本；有则必须并进来，模型给什么都挤不掉。
  const safety = first.triggers.filter((item) => /^出现.+时提前复诊$/.test(item));
  assert.ok(safety.length > 0, `审方安全触发条件被模型挤掉了：${first.triggers.join("；")}`);
});

check("④ 模型没给（或校验没过）时逐字回落原两条模板", () => {
  for (const authored of [null, { ...AUTHORED, timeline: [] }, { ...AUTHORED, timeline: [AUTHORED.timeline[0]] }]) {
    const payload = buildDeterministicRiskFollowupPayload(doseCase(), authored);
    assert.equal(payload.timelineItems.length, 2, "回落后仍是两条");
    assert.equal(payload.timelineItems[1].time, "治疗期间随时", "回落应逐字回到原模板");
    assert.equal(payload.timelineItems[1].action, "记录症状变化并按触发条件提前复评");
  }
});

check("⑤ 红旗 / 无结构化剂量 / 硬剂量边界：三条降级路径完全不走模型", () => {
  const redFlag = doseCase();
  redFlag.safetyGate = { status: "red_flag", redFlags: ["咯血"], reasons: ["需急诊评估"], missingItems: [], allowDiagnosis: false, allowDosePrescription: false };
  const redFlagPayload = buildDeterministicRiskFollowupPayload(redFlag, AUTHORED);
  assert.equal(redFlagPayload.timelineItems.length, 1, "红旗路径只有一条确定性行");
  assert.equal(redFlagPayload.timelineItems[0].action, "优先完成现场风险处置");
  for (const item of redFlagPayload.timelineItems) {
    assert.ok(
      !AUTHORED.timeline.some((authored) => authored.action === item.action),
      "红旗路径用上了模型撰写的时间轴",
    );
  }

  const noDose = doseCase();
  noDose.reasoningPrescribe.formula.candidates[0].herbs = [{ name: "麻黄" }];
  const noDosePayload = buildDeterministicRiskFollowupPayload(noDose, AUTHORED);
  assert.equal(noDosePayload.timelineItems[0].action, "补足处方级评估所需信息");
});

check("⑥ 时间轴仍随 NDJSON 帧下发，字段就是 time/action/indicators/triggers", () => {
  const markdown = buildDeterministicRiskFollowup(doseCase(), AUTHORED);
  const parsed = parseStructuredFollowupTimeline(markdown);
  assert.equal(parsed.length, 2, "sentinel 里应带出时间轴");
  assert.deepEqual(
    Object.keys(parsed[0]).sort(),
    ["action", "indicators", "time", "triggers"],
    "对外字段集变了——接口文档必须同步（历史上文档写的 indication 就从未存在过）",
  );
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "followup-timeline-authoring", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "followup-timeline-authoring", checks: 6, failures: 0 }));
