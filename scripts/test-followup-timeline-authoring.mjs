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
  sanitizeUngroundedRedFlagNegations,
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
  // 措辞有两种合法形态：「出现X时提前复诊」与「服药后出现X…时提前复诊」（审方短语自带主语时）。
  const safety = first.triggers.filter((item) => /时提前复诊$/.test(item));
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

// 2026-08-12 线上实测抓到的既有缺陷：随访时间轴帧对一整类病例**静默消失**。
// 根因是 assess 路由在发帧前先过 sanitizeUngroundedRedFlagNegations，而那个净化器
// 把 sentinel 里的 JSON 也当散文改写了——实测 `"time":"服药3天后复诊"` 被改成
// `"time":病历已记录咳嗽阳性` 并截断整个数组，下游 JSON.parse 落进 catch 返回 []。
// 没有报错、没有降级提示，集成方只会看到「有时有、有时没有」。
check("⑦ 结构化 sentinel 对文本净化器免疫，且散文侧净化照常生效", () => {
  const state = doseCase();
  state.symptoms.presentHistory += "否认发热、咯血、胸痛、气促、盗汗和体重下降。";
  const markdown = buildDeterministicRiskFollowup(state, AUTHORED);
  assert.equal(parseStructuredFollowupTimeline(markdown).length, 2, "净化前就该有两条");
  const sanitized = sanitizeUngroundedRedFlagNegations(markdown, state);
  assert.equal(
    parseStructuredFollowupTimeline(sanitized).length,
    2,
    "净化器改写了 sentinel 里的 JSON——时间轴帧会静默消失",
  );
  // 反向护栏：不能因为保护 sentinel 就把散文那一面也一并放过。
  const prose = "**待核实信息**：病历尚未确认咯血是否存在。";
  assert.notEqual(
    sanitizeUngroundedRedFlagNegations(prose, state),
    prose,
    "散文侧的未接地否定没有被净化——保护范围放太宽了",
  );
});

// ── 2026-08-12 线上实测（真实病历）抓到的三条 ────────────────────────────────
check("⑧ 审方风险行必须结构化抽取，不得把整行原文摆给医生当触发条件", () => {
  const state = doseCase();
  // 线上实测的真实审方行形态：多格、含规则名/等级/序号/处置建议/UUID。
  state.riskAssessment = [
    "## 处方安全总评",
    "规则审查 ／ 强提示 ／ 医师处方权限需确认 ／ 3 ／ 苦杏仁(捣碎) 药品主数据标注为毒性药品,当前医生权限标识为 未提供。 ／ 毒性药品处方权(主数据/官方管制目录) ／ 请确认开方医师权限;权限不足时改由有权限医师开具或调整药品。 ／ f6a08f3d-83d9-40a9-ae76-c1c6206d5301",
    "*范围说明：中成药/西药候选已按药品身份及联用边界提交；但未伪造单次剂量；剂量与具体用法仍需医生/药师人工确认。",
  ].join("\n");
  const payload = buildDeterministicRiskFollowupPayload(state, null);
  const triggers = payload.timelineItems.flatMap((item) => item.triggers);
  for (const noise of ["／", "f6a08f3d", "规则审查", "范围说明", "请确认开方医师权限"]) {
    assert.ok(
      !triggers.some((item) => item.includes(noise)),
      `审方原文噪声「${noise}」被摆进了触发条件：${triggers.join(" | ")}`,
    );
  }
  // 抽得出风险描述就该留一条可读的；抽不出宁可不生成，也不摆乱码。
  for (const item of triggers) assert.ok(item.length <= 80, `触发条件过长，八成是整行原文：${item}`);
});

check("⑨ 记录完整性陈述不得当作触发条件", () => {
  const authored = {
    ...AUTHORED,
    timeline: [
      { ...AUTHORED.timeline[0], triggers: ["出现高热或气促", "病历尚未确认发热是否存在"] },
      { ...AUTHORED.timeline[1], triggers: ["病历尚未确认发热是否存在"] },
    ],
  };
  const payload = buildDeterministicRiskFollowupPayload(doseCase(), authored);
  const triggers = payload.timelineItems.flatMap((item) => item.triggers);
  assert.ok(triggers.includes("出现高热或气促"), "真实触发条件应保留");
  assert.ok(
    !triggers.some((item) => /尚未确认|病历/.test(item)),
    `记录完整性陈述被当成了触发条件——病人不可能"出现"它：${triggers.join(" | ")}`,
  );
});

check("⑩ 首次复诊时间再长也不得让整条时间轴回落", () => {
  // 线上实测的强提示分支：firstReview = 「调整处方后当日复核；若采纳，1-3天内随访」23 字带分号。
  const state = doseCase();
  state.riskAssessment = "## 处方安全总评\n| 强提示 | 苦杏仁 | 有小毒，需复核剂量与炮制 |";
  const payload = buildDeterministicRiskFollowupPayload(state, AUTHORED);
  assert.equal(payload.timelineItems.length, 2, "强提示分支下时间轴不应缩水");
  assert.ok(
    payload.timelineItems[0].time.length > 10,
    "第一条应采用强提示分支的长时间点，而不是被判废后回落",
  );
  assert.notEqual(
    payload.timelineItems[1].action,
    "记录症状变化并按触发条件提前复评",
    "第二条回落成了模板套话——说明整条时间轴被判废了",
  );
});

// 本地实测（真实医案）第三轮抓到的两条 ──────────────────────────────────────
check("⑪ 时间轴是前瞻性内容，不得被接地净化改写成「病历尚未确认…」", () => {
  const state = doseCase();
  const authored = {
    ...AUTHORED,
    // 触发条件按定义就指向病人**现在还没有**的症状——这正是接地净化会改写的形态。
    timeline: [
      { ...AUTHORED.timeline[0], triggers: ["出现高热、腰痛加剧或肉眼血尿"] },
      { ...AUTHORED.timeline[1], triggers: ["出现头晕、乏力等贫血症状"] },
    ],
  };
  const markdown = buildDeterministicRiskFollowup(state, authored);
  const parsed = parseStructuredFollowupTimeline(sanitizeUngroundedRedFlagNegations(markdown, state));
  const triggers = parsed.flatMap((item) => item.triggers);
  assert.ok(triggers.includes("出现高热、腰痛加剧或肉眼血尿"), `触发条件被改写了：${triggers.join(" | ")}`);
  assert.ok(
    !triggers.some((item) => /尚未确认|病历/.test(item)),
    `接地净化把前瞻性触发条件改成了记录完整性陈述：${triggers.join(" | ")}`,
  );
});

check("⑫ 审方里的数据/审核完整性条目不得变成患者触发条件", () => {
  const state = doseCase();
  state.riskAssessment = [
    "## 处方安全总评",
    "剂量审查 ／ 一般提示 ／ 处方信息需复核 ／ 10 ／ 大黄䗪虫丸 未提供可识别的单次剂量,当前无法完成剂量适宜性审核。 ／ 请补充数值型单次剂量后重新审方。",
    "规则审查 ／ 一般提示 ／ 处方需重新审核 ／ - ／ 未找到与处方名称和编码一致的药品主数据,相关成分、相互作用暂不能可靠核验。",
    "规则审查 ／ 强提示 ／ 毒性中药 ／ 3 ／ 蒺藜 药品主数据标注为毒性药品,需复核剂量与炮制。",
  ].join("\n");
  const payload = buildDeterministicRiskFollowupPayload(state, null);
  const triggers = payload.timelineItems.flatMap((item) => item.triggers);
  for (const coverage of ["未提供", "未找到", "无法完成", "重新审方"]) {
    assert.ok(
      !triggers.some((item) => item.includes(coverage)),
      `数据完整性条目被写成了患者触发条件（「${coverage}」）：${triggers.join(" | ")}`,
    );
  }
  // 真正的临床风险仍要保留。
  assert.ok(
    triggers.some((item) => /毒性|蒺藜/.test(item)),
    `真实临床风险被一并过滤掉了：${triggers.join(" | ")}`,
  );
});

check("⑬ 审方安全触发条件的措辞必须读得通", () => {
  const state = doseCase();
  state.riskAssessment = [
    "## 处方安全总评",
    "规则审查 ／ 强提示 ／ 出血风险 ／ 3 ／ 抗凝治疗者合用活血化瘀药增加出血风险。",
    "规则审查 ／ 强提示 ／ 毒性中药 ／ 4 ／ 服药期间出现口唇麻木需立即停药就诊",
  ].join("\n");
  const payload = buildDeterministicRiskFollowupPayload(state, null);
  const triggers = payload.timelineItems.flatMap((item) => item.triggers);
  for (const item of triggers) {
    assert.ok(!/[。.；;，,]时提前复诊/.test(item), `措辞病句（标点前置）：${item}`);
    assert.ok(!/^出现(?:服药|用药|治疗|出现)/.test(item), `措辞病句（动词重复）：${item}`);
  }
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "followup-timeline-authoring", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "followup-timeline-authoring", checks: 13, failures: 0 }));
