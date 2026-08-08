import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BACKSTOP_RED_FLAG_CATEGORIES,
  buildClinicalFactsExtractionPrompt,
  buildClinicalFactsReviewPrompt,
  parseClinicalFacts,
  groundClinicalFacts,
  additiveRedFlagsFromFacts,
  structuredRedFlagEvidenceFromFacts,
  priorityEvaluationItemsFromFacts,
  semanticTriageAdvisoriesFromFacts,
  extractClinicalFacts,
} from "../src/lib/clinical-facts.ts";
import { withSafetyGate } from "../src/lib/diagnosis-safety.ts";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("PASS  " + name); pass++; };

// —— 护栏1 schema reject ——
assert.equal(parseClinicalFacts("not json"), null, "非JSON→null");
assert.deepEqual(parseClinicalFacts('{"nope":1}'), null, "无 redFlags 数组→null"); // no redFlags array
ok("schema: 非法附加项被隔离，不能抹掉同一输出中的合法红旗", (() => {
  const r = parseClinicalFacts(JSON.stringify({ redFlags: [
    { category: "gi_bleed", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "major_active_bleeding", quote: "黑便3天" },
    { category: "不存在", subject: "patient", status: "positive", quote: "x" },        // 非法类目
    { category: "syncope", subject: "patient", status: "编造", quote: "y" },           // 非法状态
    { category: "sepsis", subject: "patient", status: "positive", quote: "" },         // 空 quote
  ] }));
  return r?.redFlags.length === 1 && r.redFlags[0].category === "gi_bleed";
})());
ok("组合升级: 多条逐字证据可形成 additive-only 的可解释语义升级", (() => {
  const source = "50岁男性，1小时前突发胸痛，同时大汗，伴濒死感。";
  const parsed = parseClinicalFacts({
    redFlags: [{
      category: "cardiac",
      subject: "patient",
      status: "positive",
      urgency: "emergency",
      triageBasis: "time_sensitive_cardiovascular_event",
      quote: "突发胸痛",
      escalationRationale: "突发胸痛合并自主神经症状和濒死感，构成时间敏感性心血管高危组合",
      escalationEvidenceQuotes: ["突发胸痛", "大汗", "濒死感"],
    }],
  });
  const grounded = parsed && groundClinicalFacts(parsed, source);
  const message = parsed ? additiveRedFlagsFromFacts(parsed, source, [])[0] || "" : "";
  const evidence = parsed ? structuredRedFlagEvidenceFromFacts(parsed, source)[0] : undefined;
  return grounded?.redFlags[0]?.urgency === "emergency" &&
    grounded.redFlags[0].escalationEvidenceQuotes?.length === 3 &&
    !/组合升级依据|原文依据|逐字证据|[（(]/.test(message) &&
    evidence?.sourceQuote === "突发胸痛" &&
    evidence.evidenceQuotes.length === 3 &&
    evidence.evidenceQuotes.includes("大汗") &&
    evidence.evidenceQuotes.includes("濒死感");
})());
ok("组合升级: 任一组合证据未逐字落地时不得保留模型的 emergency 升级权限", (() => {
  const source = "1小时前突发胸痛，同时大汗。";
  const parsed = parseClinicalFacts({
    redFlags: [{
      category: "cardiac",
      subject: "patient",
      status: "positive",
      urgency: "emergency",
      triageBasis: "time_sensitive_cardiovascular_event",
      quote: "突发胸痛",
      escalationRationale: "胸痛、大汗并合并模型臆测的低血压",
      escalationEvidenceQuotes: ["突发胸痛", "大汗", "血压下降"],
    }],
  });
  const grounded = parsed && groundClinicalFacts(parsed, source);
  return grounded?.redFlags[0]?.urgency === "urgent" &&
    grounded.redFlags[0].triageBasis === "urgent_review" &&
    grounded.redFlags[0].escalationRationale == null;
})());
ok("prompt: 明确允许同一当前事件的多线索深层合成，同时禁止跨主体时态拼接和降低确定性结论",
  /escalationRationale/.test(buildClinicalFactsExtractionPrompt("突发胸痛伴大汗")) &&
  /不得跨患者主体、跨既往与当前事件拼接/.test(buildClinicalFactsExtractionPrompt("突发胸痛伴大汗")) &&
  /绝不能降低任何确定性结论/.test(buildClinicalFactsExtractionPrompt("突发胸痛伴大汗")));
ok("就诊范围: 仅既往稳定结论必须逐字落地且不能由单次模型获得同意状态", (() => {
  const parsed = parseClinicalFacts(JSON.stringify({
    redFlags: [],
    encounterScope: {
      status: "historical_or_stable_only",
      quote: "半年前心梗已放支架，目前无症状",
    },
  }));
  const grounded = parsed && groundClinicalFacts(parsed, "半年前心梗已放支架，目前无症状，近期心电图正常。");
  return grounded?.encounterScope?.status === "historical_or_stable_only" &&
    grounded.encounterScope.reviewAgreement === "unreviewed";
})());
ok("就诊范围: 伪造或无时态依据的历史限定引用不能落地", (() => {
  const parsed = parseClinicalFacts(JSON.stringify({
    redFlags: [],
    encounterScope: { status: "historical_or_stable_only", quote: "轻度上腹隐痛" },
  }));
  return parsed != null && groundClinicalFacts(parsed, "慢性胃炎5年，轻度上腹隐痛").encounterScope == null;
})());

const agreedHistoricalScope = await extractClinicalFacts(
  "3年前胃溃疡已治愈，目前大便正常，无呕血、无黑便。",
  async () => JSON.stringify({
    redFlags: [],
    encounterScope: {
      status: "historical_or_stable_only",
      quote: "3年前胃溃疡已治愈，目前大便正常",
    },
  }),
  undefined,
  { independentReview: true },
);
ok("就诊范围: 两次独立判断一致后才形成 agreed 历史稳定范围",
  agreedHistoricalScope?.encounterScope?.status === "historical_or_stable_only" &&
  agreedHistoricalScope.encounterScope.reviewAgreement === "agreed");

let scopeCall = 0;
const disagreedScope = await extractClinicalFacts(
  "既往胃溃疡已治愈，但今天出现上腹痛。",
  async () => {
    scopeCall += 1;
    return JSON.stringify({
      redFlags: [],
      encounterScope: scopeCall === 1
        ? { status: "historical_or_stable_only", quote: "既往胃溃疡已治愈" }
        : { status: "active_current_target", quote: "今天出现上腹痛" },
    });
  },
  undefined,
  { independentReview: true },
);
ok("就诊范围: 两模型分歧时当前阳性目标优先且不得短路处方推理",
  disagreedScope?.encounterScope?.status === "active_current_target" &&
  disagreedScope.encounterScope.reviewAgreement === "disagreed");

// —— 就诊范围类别矩阵: 当前目标 vs 既往稳定/他人/矛盾时态（沿用上文 mock-LLM 双轮模式）——
const recoveryActiveScope = await extractClinicalFacts(
  "骨折术后恢复期3周，仍有切口隐痛和患肢肿胀，希望继续调理。",
  async () => JSON.stringify({
    redFlags: [],
    encounterScope: { status: "active_current_target", quote: "仍有切口隐痛和患肢肿胀" },
  }),
  undefined,
  { independentReview: true },
);
ok("就诊范围: 恢复期仍有残余症状必须判为当前治疗目标而非既往背景",
  recoveryActiveScope?.encounterScope?.status === "active_current_target" &&
  recoveryActiveScope.encounterScope.reviewAgreement === "agreed");

const stableChronicActiveAskScope = await extractClinicalFacts(
  "高血压5年服药控制稳定，近1周头晕加重，希望本次调整治疗。",
  async () => JSON.stringify({
    redFlags: [],
    encounterScope: { status: "active_current_target", quote: "近1周头晕加重" },
  }),
  undefined,
  { independentReview: true },
);
ok("就诊范围: 慢性疾病稳定但本次明确要求治疗必须判为当前治疗目标",
  stableChronicActiveAskScope?.encounterScope?.status === "active_current_target" &&
  stableChronicActiveAskScope.encounterScope.reviewAgreement === "agreed");

// —— 疾病控制措辞不能单独支撑 historical_or_stable_only 落地（R3 活体假阳性类别）——
ok("就诊范围: 疾病控制+规律服药的引用不能落地为纯既往范围", (() => {
  const parsed = parseClinicalFacts(JSON.stringify({
    redFlags: [],
    encounterScope: { status: "historical_or_stable_only", quote: "高血压8年，规律服氨氯地平，血压控制稳定" },
  }));
  return parsed != null && groundClinicalFacts(
    parsed,
    "高血压8年，规律服氨氯地平，血压控制稳定；近2月晨起头晕头胀、项背强，本次明确要求加用中药。",
  ).encounterScope == null;
})());
ok("就诊范围: ‘血压目前稳定’只描述疾病状态，不能作为纯既往范围的落地引用", (() => {
  const parsed = parseClinicalFacts(JSON.stringify({
    redFlags: [],
    encounterScope: { status: "historical_or_stable_only", quote: "血压目前稳定" },
  }));
  return parsed != null && groundClinicalFacts(
    parsed,
    "高血压8年，血压目前稳定；近2月头晕头胀，要求中药调理。",
  ).encounterScope == null;
})());
ok("就诊范围: 不含疾病控制框架的稳定性引用仍可落地为纯既往范围", (() => {
  const parsed = parseClinicalFacts(JSON.stringify({
    redFlags: [],
    encounterScope: { status: "historical_or_stable_only", quote: "目前稳定" },
  }));
  const grounded = parsed && groundClinicalFacts(parsed, "慢性胃炎5年，目前稳定，无新发不适。");
  return grounded?.encounterScope?.status === "historical_or_stable_only";
})());
const stableChronicTreatmentRequestScope = await extractClinicalFacts(
  "高血压8年，规律服氨氯地平，血压控制稳定；近2月晨起头晕头胀、项背强，本次明确要求加用中药。舌红苔薄黄，脉弦。",
  async () => JSON.stringify({
    redFlags: [],
    encounterScope: { status: "historical_or_stable_only", quote: "高血压8年，规律服氨氯地平，血压控制稳定" },
  }),
  undefined,
  { independentReview: true },
);
ok("就诊范围: 抽取与复核同时误判时，确定性落地仍拒绝疾病控制引用并放行当前治疗目标",
  stableChronicTreatmentRequestScope != null && stableChronicTreatmentRequestScope.encounterScope == null);
const stableMetabolicTreatmentRequestScope = await extractClinicalFacts(
  "2型糖尿病6年，血糖控制可；近1月口干明显、乏力，要求干预调理。舌红少津。",
  async () => JSON.stringify({
    redFlags: [],
    encounterScope: { status: "historical_or_stable_only", quote: "2型糖尿病6年，血糖控制可" },
  }),
  undefined,
  { independentReview: true },
);
ok("就诊范围: 血糖控制可+当前症状与干预请求同样不得落地为纯既往范围",
  stableMetabolicTreatmentRequestScope != null && stableMetabolicTreatmentRequestScope.encounterScope == null);

let negationScopeCall = 0;
const negationWithOtherPositiveScope = await extractClinicalFacts(
  "高血压病史10年目前稳定；否认胸痛，但近3天持续咳嗽咳痰。",
  async () => {
    negationScopeCall += 1;
    return JSON.stringify({
      redFlags: [],
      encounterScope: negationScopeCall === 1
        // 落地契约收紧后，带疾病控制框架的稳定性引用（如“高血压…目前稳定”）不再单独落地；
        // 这里用无控制框架的“目前稳定”继续覆盖“分歧时当前阳性优先”的合并保护路径。
        ? { status: "historical_or_stable_only", quote: "目前稳定" }
        : { status: "active_current_target", quote: "近3天持续咳嗽咳痰" },
    });
  },
  undefined,
  { independentReview: true },
);
ok("就诊范围: 否认一个红旗但存在其他当前阳性症状时绝不得判为纯既往",
  negationWithOtherPositiveScope?.encounterScope?.status === "active_current_target" &&
  negationWithOtherPositiveScope.encounterScope.reviewAgreement === "disagreed");

const bystanderScope = await extractClinicalFacts(
  "陪父亲就诊，父亲目前胸痛。本人既往胃溃疡已治愈，目前无不适。",
  async () => JSON.stringify({
    redFlags: [],
    encounterScope: { status: "historical_or_stable_only", quote: "本人既往胃溃疡已治愈，目前无不适" },
  }),
  undefined,
  { independentReview: true },
);
ok("就诊范围: 家族史/陪诊者/引用病例不形成患者本人的当前治疗目标",
  bystanderScope?.encounterScope?.status === "historical_or_stable_only" &&
  bystanderScope.encounterScope.reviewAgreement === "agreed");

let tenseConflictCall = 0;
const tenseConflictScope = await extractClinicalFacts(
  "一处记录目前无胸痛，另一处又写仍有胸痛未止。",
  async () => {
    tenseConflictCall += 1;
    return JSON.stringify({
      redFlags: [],
      encounterScope: tenseConflictCall === 1
        ? { status: "historical_or_stable_only", quote: "目前无胸痛" }
        : { status: "active_current_target", quote: "仍有胸痛未止" },
    });
  },
  undefined,
  { independentReview: true },
);
ok("就诊范围: 前后时态互相矛盾时按保守当前目标处理，绝不得判为纯既往",
  tenseConflictScope?.encounterScope?.status === "active_current_target" &&
  tenseConflictScope.encounterScope.reviewAgreement === "disagreed");

let unclearHistoricalCall = 0;
const unclearVsHistoricalScope = await extractClinicalFacts(
  "患者叙述含糊，既提到旧疾已治愈，又似乎提到近日常有不适。",
  async () => {
    unclearHistoricalCall += 1;
    return JSON.stringify({
      redFlags: [],
      encounterScope: unclearHistoricalCall === 1
        ? { status: "unclear", quote: "又似乎提到近日常有不适" }
        : { status: "historical_or_stable_only", quote: "旧疾已治愈" },
    });
  },
  undefined,
  { independentReview: true },
);
ok("就诊范围: unclear 与 historical 分歧时保留 unclear 且显式标记分歧",
  unclearVsHistoricalScope?.encounterScope?.status === "unclear" &&
  unclearVsHistoricalScope.encounterScope.reviewAgreement === "disagreed");

ok("schema: emergency 缺少结构化急诊依据时整份拒绝，不默认降级后签名", (() => {
  const r = parseClinicalFacts(JSON.stringify({ redFlags: [{
    category: "vital_instability",
    subject: "patient",
    status: "positive",
    urgency: "emergency",
    quote: "血压190/122mmHg",
  }] }));
  return r === null;
})());
ok("schema: positive emergency 具备明确急诊依据时保留急诊级", (() => {
  const r = parseClinicalFacts(JSON.stringify({ redFlags: [{
    category: "respiratory",
    subject: "patient",
    status: "positive",
    urgency: "emergency",
    triageBasis: "airway_breathing_failure",
    quote: "静息也喘不上气",
  }] }));
  return r?.redFlags[0]?.urgency === "emergency";
})());
ok("schema: emergency authority requires category-specific evidence rather than an overcalled label", (() => {
  const cases = [
    ["acute_abdomen", "other_immediate_threat", "腹胀持续加重"],
    ["neuro", "acute_neurologic_deficit", "剧烈头痛"],
    ["gi_bleed", "major_active_bleeding", "呕血1次"],
    ["syncope", "other_immediate_threat", "晕厥一次，目前意识清楚"],
    ["vital_instability", "extreme_vital_instability", "呼吸32次/分"],
  ];
  return cases.every(([category, triageBasis, quote]) => {
    const parsed = parseClinicalFacts(JSON.stringify({ redFlags: [{
      category, subject: "patient", status: "positive", urgency: "emergency", triageBasis, quote,
    }] }));
    return parsed?.redFlags[0]?.urgency === "urgent" && parsed.redFlags[0].triageBasis === "urgent_review";
  });
})());
ok("schema: true acute category evidence retains emergency authority", (() => {
  const cases = [
    ["acute_abdomen", "other_immediate_threat", "突发剧烈腹痛伴反跳痛"],
    ["neuro", "acute_neurologic_deficit", "突然言语不清并右侧肢体无力"],
    ["gi_bleed", "major_active_bleeding", "黑便伴头晕乏力"],
    ["syncope", "other_immediate_threat", "反复晕厥伴持续胸痛大汗"],
    ["vital_instability", "extreme_vital_instability", "体温41℃"],
  ];
  return cases.every(([category, triageBasis, quote]) => parseClinicalFacts(JSON.stringify({ redFlags: [{
    category, subject: "patient", status: "positive", urgency: "emergency", triageBasis, quote,
  }] }))?.redFlags[0]?.urgency === "emergency");
})());
ok("grounding: 口语柏油样便合并体位性灌注不足时建立 emergency 严重度下限", (() => {
  const texts = [
    "这两天拉出来像柏油一样又黑又亮，今天站起来眼前发黑",
    "排出的便像柏油一样黑亮，起身时头晕差点晕倒",
    "站起来黑矇心慌，随后又解了黑得发亮的大便",
  ];
  return texts.every((text) => {
    const quote = text.includes("，") ? text.split("，")[0] : text;
    const grounded = groundClinicalFacts({ redFlags: [{
      category: "gi_bleed", subject: "patient", status: "positive", urgency: "urgent",
      triageBasis: "urgent_review", quote,
    }] }, text);
    return grounded.redFlags[0]?.urgency === "emergency" &&
      grounded.redFlags[0]?.triageBasis === "major_active_bleeding";
  });
})());
ok("grounding: 单次口语黑便且明确无灌注不足不越级为 emergency", (() => {
  const text = "今天一次大便像柏油一样黑亮，目前没有头晕、乏力、心悸或冷汗";
  const grounded = groundClinicalFacts({ redFlags: [{
    category: "gi_bleed", subject: "patient", status: "positive", urgency: "urgent",
    triageBasis: "urgent_review", quote: "大便像柏油一样黑亮",
  }] }, text);
  return grounded.redFlags[0]?.urgency === "urgent" && grounded.redFlags[0]?.triageBasis === "urgent_review";
})());
ok("grounding: 非患者主体的同类出血语言不得获得患者 emergency 权限", (() => {
  const text = "父亲这两天大便像柏油一样黑亮，站起来眼前发黑；我本人没有黑便或头晕";
  const grounded = groundClinicalFacts({ redFlags: [{
    category: "gi_bleed", subject: "other", status: "positive", urgency: "urgent",
    triageBasis: "urgent_review", quote: "父亲这两天大便像柏油一样黑亮，站起来眼前发黑",
  }] }, text);
  return grounded.redFlags[0]?.urgency === "urgent";
})());
ok("schema: possible 的非法过度分级使整份输出无效", (() => {
  const positive = parseClinicalFacts(JSON.stringify({ redFlags: [{ category: "acute_abdomen", subject: "patient", status: "positive", urgency: "clarify", triageBasis: "clarification_needed", quote: "腹痛持续加重" }] }));
  const possible = parseClinicalFacts(JSON.stringify({ redFlags: [{ category: "acute_abdomen", subject: "patient", status: "possible", urgency: "urgent", triageBasis: "urgent_review", quote: "好像腹痛在加重" }] }));
  return positive?.redFlags[0]?.urgency === "clarify" && possible === null;
})());
ok("schema: emergency 类目与处置依据不匹配时整份拒绝", (() => {
  const r = parseClinicalFacts(JSON.stringify({ redFlags: [{
    category: "gi_bleed",
    subject: "patient",
    status: "positive",
    urgency: "emergency",
    triageBasis: "acute_neurologic_deficit",
    quote: "大量呕血",
  }] }));
  return r === null;
})());
ok("schema: subject 缺失或非法时整份输出无效", (() => {
  const missing = parseClinicalFacts(JSON.stringify({ redFlags: [{
    category: "poisoning", status: "positive", urgency: "emergency",
    triageBasis: "other_immediate_threat", quote: "接触农药后意识模糊",
  }] }));
  const invalid = parseClinicalFacts(JSON.stringify({ redFlags: [{
    category: "poisoning", subject: "family", status: "positive", urgency: "emergency",
    triageBasis: "other_immediate_threat", quote: "接触农药后意识模糊",
  }] }));
  return missing === null && invalid === null;
})());

// —— 护栏2 grounding —— quote 必须逐字在原文
ok("grounding: quote 不在原文的 finding 被丢弃", (() => {
  const facts = { redFlags: [
    { category: "gi_bleed", subject: "patient", status: "positive", quote: "黑便3天" },   // 在原文
    { category: "syncope", subject: "patient", status: "positive", quote: "反复晕厥" },   // 不在原文(造的)
  ] };
  const g = groundClinicalFacts(facts, "主诉：黑便3天，无腹痛、无发热。");
  return g.redFlags.length === 1 && g.redFlags[0].category === "gi_bleed";
})());
ok("grounding: positive 短 quote 落在显式否定分句时被丢弃", (() => {
  const facts = { redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", quote: "黑便" }] };
  return groundClinicalFacts(facts, "患者否认黑便、呕血及便血。").redFlags.length === 0;
})());
ok("grounding: positive quote 落在既往且已缓解语境时被丢弃", (() => {
  const facts = { redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", quote: "黑便" }] };
  return groundClinicalFacts(facts, "既往曾有黑便，现已消失，今日无再发。").redFlags.length === 0;
})());
ok("grounding: 程度否定不等于症状阴性", (() => {
  const facts = { redFlags: [{ category: "acute_abdomen", subject: "patient", status: "positive", quote: "腹痛" }] };
  return groundClinicalFacts(facts, "今天出现不是很重的腹痛，但持续未缓解。").redFlags.length === 1;
})());

// —— 护栏3 status 纪律 + 护栏4 additive ——
const src = "解黑便3天，无腹痛；否认胸痛。";
ok("additive: 默认关闭(facts undefined)→ no-op", additiveRedFlagsFromFacts(undefined, src, []).length === 0);
ok("additive: grounded positive 红旗被追加", (() => {
  const facts = { redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", urgency: "emergency", quote: "解黑便3天" }] };
  const add = additiveRedFlagsFromFacts(facts, src, []);
  return add.length === 1 && add[0].includes("消化道出血");
})());
ok("additive: negative/historical/unknown 不触发", (() => {
  const facts = { redFlags: [
    { category: "gi_bleed", subject: "patient", status: "negative", quote: "解黑便3天" },
    { category: "syncope", subject: "patient", status: "unknown", quote: "解黑便3天" },
  ] };
  return additiveRedFlagsFromFacts(facts, src, []).length === 0;
})());
ok("additive: possible 只进入澄清，不升级为确定性红旗", (() => {
  const facts = { redFlags: [{ category: "gi_bleed", subject: "patient", status: "possible", urgency: "clarify", quote: "解黑便3天" }] };
  return additiveRedFlagsFromFacts(facts, src, []).length === 0;
})());
ok("advisory: grounded urgent 形成非阻断临床关注项", (() => {
  const facts = { redFlags: [{
    category: "vital_instability",
    subject: "patient",
    status: "positive",
    urgency: "urgent",
    triageBasis: "urgent_review",
    quote: "血压190/122mmHg",
  }] };
  const advisories = semanticTriageAdvisoriesFromFacts(facts, "本次血压190/122mmHg，否认胸痛气促。 ");
  return advisories.length === 1 && advisories[0].includes("优先复测") && advisories[0].includes("不中断") === false;
})());
ok("advisory: possible/clarify 形成当轮澄清项，否定和未落地事实不进入", (() => {
  const facts = { redFlags: [
    { category: "cardiac", subject: "patient", status: "possible", urgency: "clarify", triageBasis: "clarification_needed", quote: "胸口说不清地发紧" },
    { category: "gi_bleed", subject: "patient", status: "possible", urgency: "clarify", triageBasis: "clarification_needed", quote: "黑便" },
    { category: "respiratory", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "urgent_review", quote: "静息气促" },
  ] };
  const advisories = semanticTriageAdvisoriesFromFacts(facts, "胸口说不清地发紧，否认黑便。 ");
  return advisories.length === 1 && advisories[0].includes("本轮问诊中澄清");
})());
ok("additive: 当前阳性但非急诊级只进入临床分析，不升级红旗", (() => {
  const facts = { redFlags: [{ category: "respiratory", subject: "patient", status: "positive", urgency: "routine", quote: "活动后喘鸣" }] };
  return additiveRedFlagsFromFacts(facts, "最近活动后喘鸣", []).length === 0;
})());
ok("additive: ungrounded 阳性不触发(防造红旗)", (() => {
  const facts = { redFlags: [{ category: "cardiac", subject: "patient", status: "positive", quote: "剧烈胸痛放射左臂" }] };
  return additiveRedFlagsFromFacts(facts, src, []).length === 0; // quote 不在 src
})());
ok("additive: 确定性已覆盖同类目→不重复追加", (() => {
  const facts = { redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", urgency: "emergency", quote: "解黑便3天" }] };
  const existing = ["呕血、黑便或便血已出现，需先排除消化道出血等急症风险"]; // 确定性已给
  return additiveRedFlagsFromFacts(facts, src, existing).length === 0;
})());
ok("additive: 绝不移除既有确定性红旗(纯追加语义)", (() => {
  const facts = { redFlags: [] };
  const existing = ["某条确定性红旗"];
  const add = additiveRedFlagsFromFacts(facts, src, existing);
  return add.length === 0; // 只返回“待追加”,从不删 existing
})());

// 类别矩阵只验证统一结构化契约，不枚举自然语言同义词。口语映射属于 LLM 抽取器职责。
for (const category of Object.keys(BACKSTOP_RED_FLAG_CATEGORIES)) {
  const quote = `原文阳性事实-${category}`;
  const facts = { redFlags: [{ category, subject: "patient", status: "positive", urgency: "emergency", quote }] };
  const additions = additiveRedFlagsFromFacts(facts, `主诉：${quote}`, []);
  ok(`类别矩阵: ${category} grounded positive 可追加`, additions.length === 1);
}

// —— 抽取器(注入 mock LLM)——
const mockValid = async () => JSON.stringify({ redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "major_active_bleeding", quote: "解黑便3天" }] });
const mockThrow = async () => { throw new Error("model down"); };
const mockGarbage = async () => "抱歉我无法完成";
const firstExtracted = await extractClinicalFacts(src, mockValid);
ok("extractor: 合法输出→grounded facts", firstExtracted?.redFlags.length === 1);
// 这些是 async;单独 await 断言
const fThrow = await extractClinicalFacts(src, mockThrow);
ok("extractor: LLM 抛错→null(fail-closed 纯确定性)", fThrow === null);
const fGarbage = await extractClinicalFacts(src, mockGarbage);
ok("extractor: 垃圾输出→null", fGarbage === null);
let repairCalls = 0;
const repairedFacts = await extractClinicalFacts(src, async () => {
  repairCalls += 1;
  return repairCalls === 1
    ? "这不是JSON"
    : JSON.stringify({ redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "major_active_bleeding", quote: "解黑便3天" }] });
});
ok("extractor: 非法结构由模型修复轮恢复", repairCalls === 2 && repairedFacts?.redFlags.length === 1);
let pesticideRepairCalls = 0;
const repairedPesticide = await extractClinicalFacts("患者误服农药后意识模糊。", async (_system, prompt, _signal, phase) => {
  pesticideRepairCalls += 1;
  if (phase === "extract") {
    return JSON.stringify({ redFlags: [{
      category: "poisoning", subject: "patient", status: "positive", quote: "误服农药后意识模糊",
    }] });
  }
  assert.match(prompt, /结构修复/);
  return JSON.stringify({ redFlags: [{
    category: "poisoning", subject: "patient", status: "positive", urgency: "emergency",
    triageBasis: "acute_neurologic_deficit", quote: "误服农药后意识模糊",
  }] });
});
ok("extractor: 农药中毒 finding 缺 urgency/triageBasis 时整份无效且仅有限修复一次",
  pesticideRepairCalls === 2 && repairedPesticide?.redFlags[0]?.urgency === "emergency");

const nonPatientSubjectCases = [
  ["室友刚喝了农药后意识模糊，我本人没有不适。", "室友刚喝了农药后意识模糊"],
  ["同事误服农药后一直呕吐，我陪他来就诊。", "同事误服农药后一直呕吐"],
  ["候诊区其他患者接触农药后抽搐。", "其他患者接触农药后抽搐"],
  ["引用病例写道：患者误服农药后意识不清。", "患者误服农药后意识不清"],
  ["宣教文本提示：误服农药后意识模糊应立即急诊。", "误服农药后意识模糊"],
];
for (const [text, quote] of nonPatientSubjectCases) {
  const facts = await extractClinicalFacts(text, async () => JSON.stringify({ redFlags: [{
    category: "poisoning", subject: "other", status: "positive", urgency: "emergency",
    triageBasis: "acute_neurologic_deficit", quote,
  }] }));
  ok(`主体隔离: ${text.slice(0, 8)} 不形成当前患者硬红旗`,
    facts?.redFlags[0]?.subject === "other" && additiveRedFlagsFromFacts(facts, text, []).length === 0 &&
    semanticTriageAdvisoriesFromFacts(facts, text).length === 0);
}

const uncertainSubjectText = "记录中写着有人误服农药后意识模糊，但未注明是否为本患者。";
const uncertainSubjectFacts = await extractClinicalFacts(uncertainSubjectText, async () => JSON.stringify({ redFlags: [{
  category: "poisoning", subject: "uncertain", status: "positive", urgency: "clarify",
  triageBasis: "clarification_needed", quote: "有人误服农药后意识模糊",
}] }));
ok("主体隔离: uncertain 不形成硬红旗并保留主体澄清项",
  additiveRedFlagsFromFacts(uncertainSubjectFacts, uncertainSubjectText, []).length === 0 &&
  semanticTriageAdvisoriesFromFacts(uncertainSubjectFacts, uncertainSubjectText)[0]?.includes("患者本人还是他人"));
ok("schema: uncertain 不允许携带 emergency 权限", parseClinicalFacts({ redFlags: [{
  category: "poisoning", subject: "uncertain", status: "positive", urgency: "emergency",
  triageBasis: "acute_neurologic_deficit", quote: "有人误服农药后意识模糊",
}] }) === null);
const fValid = await extractClinicalFacts(src, mockValid);
ok("extractor: 合法+grounded", fValid && fValid.redFlags.length === 1 && fValid.redFlags[0].category === "gi_bleed");
let groundingRepairCalls = 0;
const repairedGrounding = await extractClinicalFacts("无明显诱因胸痛伴大汗1小时。", async () => {
  groundingRepairCalls += 1;
  return groundingRepairCalls === 1
    ? JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event", quote: "无明显诱因胸痛伴大汗1小时" }] })
    : JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event", quote: "胸痛伴大汗1小时" }] });
});
ok("extractor: 合法结构但引用范围混入非否定修饰时由受限模型修复并再次 grounding",
  groundingRepairCalls === 2 && repairedGrounding?.redFlags[0]?.quote === "胸痛伴大汗1小时");
let negativeRepairCalls = 0;
const repairedNegative = await extractClinicalFacts("患者否认黑便。", async () => {
  negativeRepairCalls += 1;
  return negativeRepairCalls === 1
    ? JSON.stringify({ redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "major_active_bleeding", quote: "否认黑便" }] })
    : JSON.stringify({ redFlags: [{ category: "gi_bleed", subject: "patient", status: "negative", urgency: "routine", triageBasis: "routine_care", quote: "否认黑便" }] });
});
ok("extractor: 引用修复可纠正模型极性且不会为保留红旗而绕过否定",
  negativeRepairCalls === 2 && repairedNegative?.redFlags[0]?.status === "negative" && additiveRedFlagsFromFacts(repairedNegative, "患者否认黑便。", []).length === 0);
const fHalluc = await extractClinicalFacts(src, async () => JSON.stringify({ redFlags: [{
  category: "cardiac", subject: "patient", status: "positive", urgency: "emergency",
  triageBasis: "time_sensitive_cardiovascular_event", quote: "剧烈胸痛",
}] }));
ok("extractor: 抽取器内即 grounding,造的 quote 被剔除", fHalluc && fHalluc.redFlags.length === 0);
let independentReviewCalls = 0;
const independentlyReviewed = await extractClinicalFacts("胸痛没有缓解，伴随症状暂未记录。", async (_system, _user, _signal, phase) => {
  independentReviewCalls += 1;
  return phase === "review"
    ? JSON.stringify({ redFlags: [{ findingId: "rf-1", category: "cardiac", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event", quote: "胸痛没有缓解" }], reviews: [{ findingId: "rf-1", decision: "modify" }] })
    : JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "positive", urgency: "clarify", triageBasis: "clarification_needed", quote: "胸痛没有缓解" }] });
}, undefined, { independentReview: true });
ok("extractor: 独立LLM复核可纠正首轮处置层级且仍受逐字引用契约约束",
  independentReviewCalls === 2 && independentlyReviewed?.reviewStatus === "checked" && independentlyReviewed.redFlags[0]?.urgency === "emergency");
let invalidReviewContractAttempts = 0;
const recoveredInvalidReviewContract = await extractClinicalFacts("右边脑袋一跳一跳地疼。", async (_system, _user, _signal, phase) => {
  if (phase !== "review") return JSON.stringify({ redFlags: [{ category: "neuro", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "urgent_review", quote: "右边脑袋一跳一跳地疼" }] });
  invalidReviewContractAttempts += 1;
  return invalidReviewContractAttempts === 1
    ? JSON.stringify({ redFlags: [] })
    : JSON.stringify({
        redFlags: [{ findingId: "rf-1", category: "neuro", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "urgent_review", quote: "右边脑袋一跳一跳地疼" }],
        reviews: [{ findingId: "rf-1", decision: "confirm" }],
      });
}, undefined, { independentReview: true, allowDispositionReductions: true });
ok("extractor: 非空但违反findingId合同的独立复核可在相同首轮事实上一轮受限重试恢复",
  invalidReviewContractAttempts === 2 && recoveredInvalidReviewContract?.reviewStatus === "checked" && recoveredInvalidReviewContract.redFlags.length === 1);
const omittedByReviewer = await extractClinicalFacts("胸痛没有缓解，已持续30分钟。", async (_system, _user, _signal, phase) => phase === "review"
  ? JSON.stringify({ redFlags: [] })
  : JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event", quote: "胸痛没有缓解，已持续30分钟" }] }), undefined, { independentReview: true, allowDispositionReductions: true });
ok("extractor: 复核空结果不得静默擦除首轮已落地急症",
  omittedByReviewer?.reviewStatus === "unavailable" && omittedByReviewer.redFlags[0]?.urgency === "emergency");
const replacedBySameCategoryHistory = await extractClinicalFacts("当前持续胸痛30分钟；既往胸痛现已缓解。", async (_system, _user, _signal, phase) => phase === "review"
  ? JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "historical", urgency: "routine", triageBasis: "routine_care", quote: "既往胸痛现已缓解" }], reviews: [] })
  : JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event", quote: "当前持续胸痛30分钟" }] }), undefined, { independentReview: true, allowDispositionReductions: true });
ok("extractor: 同类目的另一条既往事实不能冒名覆盖当前急症",
  replacedBySameCategoryHistory?.reviewStatus === "unavailable" && replacedBySameCategoryHistory.redFlags[0]?.quote === "当前持续胸痛30分钟");
const silentlyReassignedSubject = await extractClinicalFacts("患者持续胸痛30分钟。", async (_system, _user, _signal, phase) => phase === "review"
  ? JSON.stringify({ redFlags: [{ category: "cardiac", subject: "other", status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event", quote: "持续胸痛30分钟" }], reviews: [] })
  : JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event", quote: "持续胸痛30分钟" }] }), undefined, { independentReview: true, allowDispositionReductions: true });
ok("extractor: 复核不得在无 findingId 裁决时静默改写主体",
  silentlyReassignedSubject?.reviewStatus === "unavailable" && silentlyReassignedSubject.redFlags[0]?.subject === "patient");
const explicitlyRejectedFinding = await extractClinicalFacts("胸口不适已澄清为胃胀；既往胸痛现已缓解。", async (_system, _user, _signal, phase) => phase === "review"
  ? JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "historical", urgency: "routine", triageBasis: "routine_care", quote: "既往胸痛现已缓解" }], reviews: [{ findingId: "rf-1", decision: "reject", dispositionChangeEvidence: { basis: "polarity_correction", quote: "胸口不适已澄清为胃胀" } }] })
  : phase === "adjudicate"
    ? JSON.stringify({ decisions: [{ findingId: "rf-1", allowReduction: true, evidenceQuote: "胸口不适已澄清为胃胀" }] })
    : JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "possible", urgency: "clarify", triageBasis: "clarification_needed", quote: "胸口不适" }] }), undefined, { independentReview: true, allowDispositionReductions: true });
ok("extractor: 独立复核可用findingId显式拒绝错误首轮事实",
  explicitlyRejectedFinding?.reviewStatus === "checked" && explicitlyRejectedFinding.redFlags.every((item) => item.quote !== "胸口不适"));
const explicitlyModifiedFinding = await extractClinicalFacts("刚才大量呕鲜血一直没停，面色苍白出冷汗，人已经意识模糊。", async (_system, _user, _signal, phase) => phase === "review"
  ? JSON.stringify({
      redFlags: [{ findingId: "rf-1", category: "gi_bleed", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "shock_or_anaphylaxis", quote: "大量呕鲜血一直没停" }],
      reviews: [{ findingId: "rf-1", decision: "modify" }],
    })
  : JSON.stringify({ redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "major_active_bleeding", quote: "刚才大量呕鲜血一直没停，面色苍白出冷汗，人已经意识模糊" }] }), undefined, { independentReview: true });
ok("extractor: findingId裁决允许复核模型修正依据片段而不会被误判为遗漏",
  explicitlyModifiedFinding?.reviewStatus === "checked" &&
  explicitlyModifiedFinding.redFlags[0]?.quote === "大量呕鲜血一直没停");

const staleClearanceCannotDowngrade = await extractClinicalFacts("当前胸痛持续30分钟未缓解；昨日心电图正常。", async (_system, _user, _signal, phase) => phase === "review"
  ? JSON.stringify({ redFlags: [], reviews: [{ findingId: "rf-1", decision: "reject", dispositionChangeEvidence: { basis: "current_same_episode_clearance", quote: "昨日心电图正常" } }] })
  : phase === "adjudicate"
    ? JSON.stringify({ decisions: [{ findingId: "rf-1", allowReduction: true, evidenceQuote: "昨日心电图正常" }] })
    : JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event", quote: "当前胸痛持续30分钟未缓解" }] }), undefined, { independentReview: true, allowDispositionReductions: true });
ok("extractor: 陈旧检查即使被复核模型误作清除证据，也必须经第三方裁决拒绝降级",
  staleClearanceCannotDowngrade?.reviewStatus === "checked" && staleClearanceCannotDowngrade.redFlags[0]?.urgency === "emergency");

const modelConsensusCannotEraseEmergency = await extractClinicalFacts("吃完花生后嗓子眼一下堵住了，声音发不出来，脸也肿。", async (_system, _user, _signal, phase) => phase === "review"
  ? JSON.stringify({ redFlags: [], reviews: [{ findingId: "rf-1", decision: "reject", dispositionChangeEvidence: { basis: "polarity_correction", quote: "嗓子眼一下堵住了" } }] })
  : phase === "adjudicate"
    ? JSON.stringify({ decisions: [{ findingId: "rf-1", allowReduction: true, evidenceQuote: "嗓子眼一下堵住了" }] })
    : JSON.stringify({ redFlags: [{ category: "anaphylaxis", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "airway_breathing_failure", quote: "嗓子眼一下堵住了" }] }), undefined, { independentReview: true, allowDispositionReductions: true });
ok("extractor: 多模型一致的错误解释也不能擦除已落地 emergency",
  modelConsensusCannotEraseEmergency?.reviewStatus === "checked" && modelConsensusCannotEraseEmergency.redFlags[0]?.urgency === "emergency");

const adjudicatorRejectsReduction = await extractClinicalFacts("手划伤后渗血半小时还没完全停，出血量说不清。", async (_system, _user, _signal, phase) => phase === "review"
  ? JSON.stringify({
      redFlags: [{ findingId: "rf-1", category: "bleeding", subject: "patient", status: "positive", urgency: "clarify", triageBasis: "clarification_needed", quote: "手划伤后渗血半小时还没完全停" }],
      reviews: [{ findingId: "rf-1", decision: "modify", dispositionChangeEvidence: { basis: "current_same_episode_clearance", quote: "渗血" } }],
    })
  : phase === "adjudicate"
    ? JSON.stringify({ decisions: [{ findingId: "rf-1", allowReduction: false, evidenceQuote: "手划伤后渗血半小时还没完全停" }] })
    : JSON.stringify({ redFlags: [{ category: "bleeding", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "urgent_review", quote: "手划伤后渗血半小时还没完全停" }] }), undefined, { independentReview: true, allowDispositionReductions: true });
ok("extractor: 第三方拒绝降级时保留更高处置级且复核仍为已完成",
  adjudicatorRejectsReduction?.reviewStatus === "checked" &&
  adjudicatorRejectsReduction.redFlags.length === 1 &&
  adjudicatorRejectsReduction.redFlags[0]?.urgency === "urgent");

const ungroundedDowngradeCannotClear = await extractClinicalFacts("近2日右侧无力明显加重。", async (_system, _user, _signal, phase) => phase === "review"
  ? JSON.stringify({ redFlags: [], reviews: [{ findingId: "rf-1", decision: "reject" }] })
  : JSON.stringify({ redFlags: [{ category: "neuro", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "acute_neurologic_deficit", quote: "近2日右侧无力明显加重" }] }), undefined, { independentReview: true, allowDispositionReductions: true });
ok("extractor: 缺少逐字降级证据时复核不能清除已落地急症",
  ungroundedDowngradeCannotClear?.reviewStatus === "unavailable" && ungroundedDowngradeCannotClear.redFlags[0]?.urgency === "emergency");

// —— 端到端集成:高频口语急症表达必须由确定性层直接覆盖，结构化事实仅作加法兜底 ——
const { detectProgrammaticRedFlags, narrativeFallbackAdvisories } = await import("../src/lib/diagnosis-safety.ts");
const colloquial = "老人家最近大便发黑好几天了，人也没力气";
const deterministicOnly = detectProgrammaticRedFlags({ chiefComplaint: colloquial, conversation: [] });
ok("降级集成: 模型不可用时口语“大便发黑”只形成非阻断提示",
  deterministicOnly.length === 0 && narrativeFallbackAdvisories({ chiefComplaint: colloquial, conversation: [] }).some((f) => f.includes("消化道出血")));
ok("降级集成: 否认口语“大便发黑”不误报",
  !narrativeFallbackAdvisories({ chiefComplaint: "否认大便发黑、呕血和便血", conversation: [] }).some((f) => f.includes("消化道出血")));
const withBackstop = detectProgrammaticRedFlags({
  chiefComplaint: colloquial,
  conversation: [],
  clinicalFacts: { redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", urgency: "emergency", quote: "大便发黑好几天" }] },
});
ok("集成: T6 规定语义发现不单独取得硬红旗门权",
  withBackstop.length === 0);
ok("集成: 语义 emergency 保留为有原文依据的立即复核提醒",
  semanticTriageAdvisoriesFromFacts({ redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "major_active_bleeding", quote: "大便发黑好几天" }] }, colloquial)
    .some((item) => item.includes("立即由接诊医生现场复核") && item.includes("大便发黑好几天")));
ok("集成: 语义 emergency 不取得确定性硬门权但必须阻止未经复核的正式处方采纳", (() => {
  const facts = { redFlags: [{ category: "gi_bleed", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "major_active_bleeding", quote: "大便发黑好几天" }] };
  return priorityEvaluationItemsFromFacts(facts, colloquial)
    .some((item) => item.includes("立即现场复核") && item.includes("大便发黑好几天"));
})());
ok("稳定性: T6 将孤立非急性胸闷约束为常规背景，避免批量推理时随机升级", (() => {
  const text = "痰多胸闷2周";
  return [
    { status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event" },
    { status: "possible", urgency: "clarify", triageBasis: "clarification_needed" },
  ].every((classification) => {
    const facts = { redFlags: [{ category: "cardiac", subject: "patient", ...classification, quote: "胸闷2周" }] };
    const grounded = groundClinicalFacts(facts, text).redFlags[0];
    return grounded?.urgency === "routine" && grounded.triageBasis === "routine_care" &&
      priorityEvaluationItemsFromFacts(facts, text).length === 0;
  });
})());

// —— 隐私边界: 即使生产开启 LLM 事实回填，外发文本也必须先经过统一 PHI 清洗 ——
delete process.env.CDSS_CLINICAL_FACTS_BACKSTOP;
process.env.CLINICAL_FACTS_ATTESTATION_KEY = "clinical-facts-test-key-2026";
const {
  CLINICAL_FACTS_ATTESTATION_VERSION,
  CLINICAL_FACTS_CACHE_TTL_MS,
  CLINICAL_FACTS_EMPTY_CACHE_TTL_MS,
  CLINICAL_FACTS_EXTRACTOR_VERSION,
  CLINICAL_FACTS_PROMPT_VERSION,
  callClinicalFactsPhaseWithRetry,
  clinicalFactsAttestationSigningConfigured,
  hasValidClinicalFactsAttestation,
  isClinicalFactsBackstopEnabled,
  maybeAttachClinicalFactsBackstop,
} = await import("../src/lib/clinical-facts-runtime.ts");
ok("运行时: LLM语义红旗层默认启用", isClinicalFactsBackstopEnabled());
ok("运行时: 导出 clinical facts 签名配置 readiness", clinicalFactsAttestationSigningConfigured());
let transientPhaseCalls = 0;
const recoveredPhase = await callClinicalFactsPhaseWithRetry(async () => {
  transientPhaseCalls += 1;
  if (transientPhaseCalls === 1) throw new Error("temporary transport failure");
  return '{"redFlags":[]}';
}, undefined, 2);
ok("运行时: 安全语义阶段的首次瞬时传输失败由一次受限重试恢复",
  transientPhaseCalls === 2 && recoveredPhase === '{"redFlags":[]}');
let emptyPhaseCalls = 0;
const recoveredEmptyPhase = await callClinicalFactsPhaseWithRetry(async () => {
  emptyPhaseCalls += 1;
  return emptyPhaseCalls === 1 ? "" : '{"redFlags":[]}';
}, undefined, 2);
ok("运行时: 安全语义阶段的空响应由一次受限重试恢复",
  emptyPhaseCalls === 2 && recoveredEmptyPhase === '{"redFlags":[]}');
const preAbortedPhase = new AbortController();
preAbortedPhase.abort(new Error("request_cancelled"));
let abortedPhaseCalls = 0;
await callClinicalFactsPhaseWithRetry(async () => {
  abortedPhaseCalls += 1;
  return '{"redFlags":[]}';
}, preAbortedPhase.signal, 2).catch(() => undefined);
ok("运行时: 客户端取消后不得继续安全语义重试", abortedPhaseCalls === 0);
const healthRouteSource = readFileSync(new URL("../src/app/api/diagnosis/health/route.ts", import.meta.url), "utf8");
ok("health: strict readiness 纳入 clinical facts 启用与签名配置状态",
  healthRouteSource.includes("clinicalFactsAttestationSigningConfigured") &&
  healthRouteSource.includes("getClinicalFactsModelPlan") &&
  healthRouteSource.includes("clinicalFactsModelPlanReady") &&
  healthRouteSource.includes("clinical_facts_reviewer_not_separate_invocation") &&
  healthRouteSource.includes("separateInvocationReview") &&
  healthRouteSource.includes("separateInvocationAdjudication") &&
  healthRouteSource.includes("probeClinicalFactsModels") &&
  healthRouteSource.includes("clinical_facts_model_chain_unavailable") &&
  healthRouteSource.includes("clinicalFactsReady") &&
  healthRouteSource.includes("clinical_facts_attestation_key_not_configured") &&
  healthRouteSource.includes("strictReady") &&
  healthRouteSource.includes("clinicalFacts: {"));
let capturedFactsPrompt = "";
await maybeAttachClinicalFactsBackstop({
  id: "phi-backstop",
  phase: "diagnose",
  patient: { name: "张三", sex: "男", age: 45 },
  chiefComplaint: "张三近三日胸闷，手机13800138000",
  symptoms: {},
  conversation: [],
  hisRecord: {
    source: "his",
    rawText: "姓名:张三；MRN:ABCD1234；地址:成都市青羊区某路1号；出生日期:1981-02-03；联系人:John Smith；胸闷3日",
    fields: { patientName: "张三", zhushu: "胸闷3日", xianbingshi: "电话13800138000；病历号:MRN778899" },
  },
}, async (_system, user) => {
  capturedFactsPrompt = user;
  return JSON.stringify({ redFlags: [] });
});
ok("隐私: 事实回填模型不接收姓名/MRN/电话/地址/出生日期", Boolean(capturedFactsPrompt) &&
  !/\u5f20\u4e09|ABCD1234|MRN778899|13800138000|\u6210\u90fd\u5e02\u9752\u7f8a\u533a|1981-02-03|John Smith/.test(capturedFactsPrompt));
ok("隐私: 脱敏后仍保留临床事实供红旗抽取", /胸闷/.test(capturedFactsPrompt));

// —— 根因级覆盖:模型理解基层口语，规则无需为每种说法追加关键词 ——
const colloquialSemanticCases = [
  ["这两天大便像柏油一样黑", "gi_bleed", "这两天大便像柏油一样黑", "消化道出血", "major_active_bleeding"],
  ["突然说不出话，右边手脚也抬不起来", "neuro", "说不出话，右边手脚也抬不起来", "急性神经功能异常", "acute_neurologic_deficit"],
  ["突然喘不上气，嘴唇发紫", "respiratory", "喘不上气，嘴唇发紫", "呼吸循环", "airway_breathing_failure"],
  ["右下肚子突然疼得厉害，松手更疼", "acute_abdomen", "右下肚子突然疼得厉害，松手更疼", "急腹症", "other_immediate_threat"],
];
for (const [chiefComplaint, category, quote, expectedMessage, triageBasis] of colloquialSemanticCases) {
  const enriched = await maybeAttachClinicalFactsBackstop({
    id: `semantic-${category}`,
    phase: "collect",
    patient: {},
    chiefComplaint,
    symptoms: {},
    conversation: [],
    completeness: { level: "A", redFlag: 0, infoGain: 0, managementImpact: 0, answerability: 0 },
    questionRounds: 0,
    maxQuestionRounds: 1,
  }, async (_system, _user, _signal, phase) => JSON.stringify({
    redFlags: [{ ...(phase === "review" ? { findingId: "rf-1" } : {}), category, subject: "patient", status: "positive", urgency: "emergency", triageBasis, quote }],
    ...(phase === "review" ? { reviews: [{ findingId: "rf-1", decision: "confirm" }] } : {}),
  }));
  const deterministicHits = detectProgrammaticRedFlags(enriched);
  const semanticAdvisories = semanticTriageAdvisoriesFromFacts(enriched.clinicalFacts, chiefComplaint);
  ok(`语义覆盖: ${chiefComplaint}`,
    deterministicHits.some((item) => item.includes(expectedMessage)) ||
    semanticAdvisories.some((item) => item.includes(quote)));
  if (!deterministicHits.some((item) => item.includes(expectedMessage))) {
    ok(`语义权限边界: ${chiefComplaint}`, semanticAdvisories.some((item) => item.includes("不单独形成硬门")));
  }
}

const possibleState = await maybeAttachClinicalFactsBackstop({
  id: "semantic-possible",
  phase: "collect",
  patient: {},
  chiefComplaint: "说是胸口有点说不清的压迫感",
  symptoms: {},
  conversation: [],
  completeness: { level: "B", redFlag: 0.6, infoGain: 0.6, managementImpact: 0.6, answerability: 0.6 },
  questionRounds: 0,
  maxQuestionRounds: 1,
}, async (_system, _user, _signal, phase) => JSON.stringify({
  redFlags: [{ ...(phase === "review" ? { findingId: "rf-1" } : {}), category: "cardiac", subject: "patient", status: "possible", urgency: "clarify", triageBasis: "clarification_needed", quote: "说不清的压迫感" }],
  ...(phase === "review" ? { reviews: [{ findingId: "rf-1", decision: "confirm" }] } : {}),
}));
ok("语义纪律: possible保留为追问目标但不直接升级红旗",
  possibleState.clinicalFacts?.redFlags[0]?.status === "possible" && detectProgrammaticRedFlags(possibleState).length === 0);

const signedEmergencyProtectedFromEmptyReview = await maybeAttachClinicalFactsBackstop({
  ...possibleState,
  id: "signed-emergency-empty-review",
  chiefComplaint: "胸痛没有缓解，已持续30分钟",
  clinicalFacts: undefined,
}, async (_system, _user, _signal, phase) => phase === "review"
  ? JSON.stringify({ redFlags: [] })
  : JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event", quote: "胸痛没有缓解，已持续30分钟" }] }));
ok("信任边界: 非独立降级路径按单调合并保留持续胸痛并签署保守结果",
  hasValidClinicalFactsAttestation(signedEmergencyProtectedFromEmptyReview.clinicalFacts) &&
  signedEmergencyProtectedFromEmptyReview.clinicalFacts?.reviewStatus === "checked" &&
  detectProgrammaticRedFlags(signedEmergencyProtectedFromEmptyReview).some((item) => /心血管|胸痛/.test(item)));

const signedEmptyCannotCloseCatastrophicFloor = await maybeAttachClinicalFactsBackstop({
  ...possibleState,
  id: "signed-empty-catastrophic-floor",
  chiefComplaint: "当前胸痛持续30分钟未缓解",
  clinicalFacts: undefined,
}, async () => JSON.stringify({ redFlags: [] }));
ok("信任边界: 两轮模型都漏报并形成签名空结果时仍不能关闭灾难性安全下限",
  hasValidClinicalFactsAttestation(signedEmptyCannotCloseCatastrophicFloor.clinicalFacts) &&
  detectProgrammaticRedFlags(signedEmptyCannotCloseCatastrophicFloor).some((item) => /心血管|胸痛/.test(item)) &&
  withSafetyGate(signedEmptyCannotCloseCatastrophicFloor).safetyGate?.status === "red_flag");

const unsignedEmptyExtractionAfterReviewFailure = await maybeAttachClinicalFactsBackstop({
  ...possibleState,
  id: "unsigned-empty-extraction-review-failure",
  chiefComplaint: "当前胸痛持续30分钟未缓解",
  clinicalFacts: undefined,
}, async (_system, _user, _signal, phase) => {
  if (phase === "review") throw new Error("review provider unavailable");
  return JSON.stringify({ redFlags: [] });
});
ok("信任边界: 首轮空结果且复核失败不签名，当前胸痛仍由极端安全底线捕获",
  unsignedEmptyExtractionAfterReviewFailure.clinicalFacts?.reviewStatus === "unavailable" &&
  !hasValidClinicalFactsAttestation(unsignedEmptyExtractionAfterReviewFailure.clinicalFacts) &&
  detectProgrammaticRedFlags(unsignedEmptyExtractionAfterReviewFailure).some((item) => /心血管|胸痛/.test(item)));

let longSourcePrompt = "";
const longSourceState = await maybeAttachClinicalFactsBackstop({
  ...possibleState,
  id: "partial-long-source",
  chiefComplaint: "复诊评估",
  clinicalFacts: undefined,
  hisRecord: {
    schemaVersion: "his-record-v1",
    source: "his",
    caseId: "long-source",
    updatedAt: new Date().toISOString(),
    rawText: "慢性随访资料。".repeat(2200),
    fields: { xianbingshi: "当前胸痛持续30分钟未缓解" },
  },
}, async (_system, user, _signal, phase) => {
  longSourcePrompt = user;
  const finding = { category: "cardiac", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event", quote: "当前胸痛持续30分钟未缓解" };
  return JSON.stringify({ redFlags: [finding], ...(phase === "review" ? { reviews: [{ findingId: "rf-1", decision: "confirm" }] } : {}) });
});
ok("长病历: 语义模型会看到投影后的最新尾部事实", longSourcePrompt.includes("当前胸痛持续30分钟未缓解"));
ok("长病历: 部分覆盖不伪装全文已审且仍保留安全底线",
  longSourceState.clinicalFacts?.sourceCoverage === "partial" &&
  !hasValidClinicalFactsAttestation(longSourceState.clinicalFacts) &&
  detectProgrammaticRedFlags(longSourceState).some((item) => /心血管|胸痛/.test(item)));

let rawTailPrompt = "";
const rawTailQuote = "最新补充：刚刚误服敌敌畏后昏迷，呼吸越来越弱";
const rawTailState = await maybeAttachClinicalFactsBackstop({
  ...possibleState,
  id: "partial-real-raw-tail",
  chiefComplaint: "复诊评估",
  clinicalFacts: undefined,
  hisRecord: {
    schemaVersion: "his-record-v1",
    source: "his",
    caseId: "raw-tail",
    updatedAt: new Date().toISOString(),
    rawText: `${"慢性随访资料。".repeat(2200)}${rawTailQuote}`,
    fields: {},
  },
}, async (_system, user, _signal, phase) => {
  rawTailPrompt = user;
  const finding = { category: "poisoning", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "airway_breathing_failure", quote: rawTailQuote };
  return JSON.stringify({ redFlags: [finding], ...(phase === "review" ? { reviews: [{ findingId: "rf-1", decision: "confirm" }] } : {}) });
});
ok("长病历: 急症仅位于真实 rawText 尾部时仍进入模型输入", rawTailPrompt.includes(rawTailQuote));
ok("长病历: 真实 rawText 中段被省略后不得获得全文可信签名",
  rawTailState.clinicalFacts?.sourceCoverage === "partial" && !hasValidClinicalFactsAttestation(rawTailState.clinicalFacts));

const activityWheezeState = await maybeAttachClinicalFactsBackstop({
  ...possibleState,
  id: "semantic-activity-wheeze",
  chiefComplaint: "一跑快了胸口呼呼响，晚上有时憋醒",
  clinicalFacts: undefined,
}, async (_system, _user, _signal, phase) => JSON.stringify({
  redFlags: [{ ...(phase === "review" ? { findingId: "rf-1" } : {}), category: "respiratory", subject: "patient", status: "positive", urgency: "clarify", triageBasis: "clarification_needed", quote: "一跑快了胸口呼呼响，晚上有时憋醒" }],
  ...(phase === "review" ? { reviews: [{ findingId: "rf-1", decision: "confirm" }] } : {}),
}));
ok("语义分诊: 活动后喘鸣与偶发夜醒进入澄清，不被改写成静息急性呼吸困难",
  detectProgrammaticRedFlags(activityWheezeState).length === 0 && activityWheezeState.clinicalFacts?.redFlags[0]?.urgency === "clarify");

const restingDyspneaState = await maybeAttachClinicalFactsBackstop({
  ...possibleState,
  id: "semantic-resting-dyspnea",
  chiefComplaint: "现在静息也喘不上气，不能平卧，说一句话要停几次",
  clinicalFacts: undefined,
}, async (_system, _user, _signal, phase) => JSON.stringify({
  redFlags: [{ ...(phase === "review" ? { findingId: "rf-1" } : {}), category: "respiratory", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "airway_breathing_failure", quote: "静息也喘不上气，不能平卧，说一句话要停几次" }],
  ...(phase === "review" ? { reviews: [{ findingId: "rf-1", decision: "confirm" }] } : {}),
}));
ok("语义分诊: 当前静息重度呼吸困难触发急诊级红旗",
  detectProgrammaticRedFlags(restingDyspneaState).some((item) => /急性呼吸受损|呼吸循环急症/.test(item)));
ok("运行时: 新抽取结果带完整版本化证明与 fresh/checked 状态", (() => {
  const facts = possibleState.clinicalFacts;
  return facts?.semanticStatus === "checked" &&
    facts.resultSource === "fresh" &&
    facts.attestationVersion === CLINICAL_FACTS_ATTESTATION_VERSION &&
    facts.extractorVersion === CLINICAL_FACTS_EXTRACTOR_VERSION &&
    facts.promptVersion === CLINICAL_FACTS_PROMPT_VERSION &&
    Number.isFinite(Date.parse(facts.extractedAt)) &&
    hasValidClinicalFactsAttestation(facts);
})());
const { normalizeCaseStateInput } = await import("../src/lib/diagnosis-types.ts");
const normalizedPossibleState = normalizeCaseStateInput(JSON.parse(JSON.stringify(possibleState)));
ok("运行时: modelTrace 经 JSON 与请求归一化后保留，签名仍可复用", Boolean(
  normalizedPossibleState?.clinicalFacts?.modelTrace?.extractor?.model &&
  hasValidClinicalFactsAttestation(normalizedPossibleState.clinicalFacts),
));

const semanticNegative = {
  id: "semantic-negative",
  phase: "collect",
  patient: {},
  chiefComplaint: "大便是深褐色，不是黑便，也没有吐血",
  symptoms: {},
  conversation: [],
  completeness: { level: "A", redFlag: 0, infoGain: 0, managementImpact: 0, answerability: 0 },
  questionRounds: 0,
  maxQuestionRounds: 1,
  clinicalFacts: { redFlags: [{ category: "gi_bleed", subject: "patient", status: "negative", quote: "不是黑便，也没有吐血" }] },
};
ok("本地极性: 显式阴性不被关键词误升级", !detectProgrammaticRedFlags(semanticNegative).some((item) => item.includes("消化道出血")));

for (const clinicalFacts of [
  { redFlags: [{ category: "cardiac", subject: "patient", status: "negative", quote: "否认腹痛" }] },
  { redFlags: [{ category: "cardiac", subject: "patient", status: "negative", quote: "突发胸痛" }] },
]) {
  const maliciousDowngrade = {
    ...semanticNegative,
    chiefComplaint: "突发胸痛持续30分钟伴冷汗；否认腹痛",
    clinicalFacts,
  };
  ok("additive-only: 模型非阳性事实不能压掉确定性胸痛红旗",
    detectProgrammaticRedFlags(maliciousDowngrade).some((item) => /胸痛|心血管/.test(item)));
}

const checkedEmptyCannotEraseEmergency = {
  ...semanticNegative,
  chiefComplaint: "突发胸痛持续30分钟伴冷汗",
  clinicalFacts: {
    redFlags: [],
    semanticStatus: "checked",
    resultSource: "fresh",
  },
};
ok("混合架构: checked空语义结果不能删除明确急性胸痛下限",
  detectProgrammaticRedFlags(checkedEmptyCannotEraseEmergency).some((item) => /胸痛|心血管/.test(item)));

const checkedExerciseWheezeIsNotEmergency = {
  ...semanticNegative,
  chiefComplaint: "跑快了胸口呼呼响，晚上偶尔憋醒",
  symptoms: { presentHistory: "目前说话走路正常，没有胸痛，旧吸入药十分钟能缓解" },
  clinicalFacts: {
    redFlags: [{ category: "respiratory", subject: "patient", status: "positive", urgency: "clarify", quote: "跑快了胸口呼呼响" }],
    semanticStatus: "checked",
    resultSource: "fresh",
  },
};
ok("混合架构: 运动诱发喘鸣与当前稳定状态不会被确定性下限误报急诊",
  !detectProgrammaticRedFlags(checkedExerciseWheezeIsNotEmergency).some((item) => /呼吸循环急症|心血管事件/.test(item)));

const semanticNegativeWithCriticalVital = {
  ...semanticNegative,
  vitals: { bloodPressure: "225/135" },
};
ok("混合架构: LLM阴性不影响确定性危急生命体征", detectProgrammaticRedFlags(semanticNegativeWithCriticalVital).some((item) => item.includes("225/135")));

const unchangedCalls = { count: 0 };
const cachedPossibleState = await maybeAttachClinicalFactsBackstop(possibleState, async () => {
  unchangedCalls.count += 1;
  return JSON.stringify({ redFlags: [] });
});
ok("运行时: 病历未变化时按指纹复用结论", unchangedCalls.count === 0);
ok("运行时: 缓存命中与新抽取状态可区分",
  cachedPossibleState.clinicalFacts?.semanticStatus === "checked" && cachedPossibleState.clinicalFacts?.resultSource === "cache");

for (const [field, staleValue] of [
  ["attestationVersion", "tcm-cdss-clinical-facts-attestation-stale"],
  ["extractorVersion", "clinical-facts-extractor-stale"],
  ["promptVersion", "clinical-facts-prompt-stale"],
]) {
  const versionCalls = { count: 0 };
  await maybeAttachClinicalFactsBackstop({
    ...possibleState,
    clinicalFacts: { ...possibleState.clinicalFacts, [field]: staleValue },
  }, async (_system, _user, _signal, phase) => {
    if (phase === "extract") versionCalls.count += 1;
    return JSON.stringify({ redFlags: [] });
  });
  ok(`缓存生命周期: ${field} 变化强制重抽`, versionCalls.count === 1);
}

ok("缓存生命周期: 空结果 TTL 短于有 finding 的结果", CLINICAL_FACTS_EMPTY_CACHE_TTL_MS < CLINICAL_FACTS_CACHE_TTL_MS);
// 钉住抬 TTL 的**理由**而不只是数字：短 TTL 必须覆盖一次完整的 M03→M04→M05 链路，否则"无红旗"
// 这个多数病例每次都在 M05 过期重抽（实测 diagnose+prescribe p50 57.4s、488/488 全部 > 30s），
// 把一个对外声称完全确定性的阶段变成两次串行模型调用。改小回去必须同时给出新的实测依据。
ok(
  "缓存生命周期: 空结果 TTL 覆盖一次完整链路(≥120s)",
  CLINICAL_FACTS_EMPTY_CACHE_TTL_MS >= 120_000,
);
const realDateNow = Date.now;
const emptyExtractedAtMs = realDateNow() - CLINICAL_FACTS_EMPTY_CACHE_TTL_MS - 1_000;
let expiredEmptyState;
try {
  Date.now = () => emptyExtractedAtMs;
  expiredEmptyState = await maybeAttachClinicalFactsBackstop({
    ...possibleState,
    id: "semantic-empty-ttl",
    chiefComplaint: "目前无明确急危重线索",
    clinicalFacts: undefined,
  }, async () => JSON.stringify({ redFlags: [] }));
} finally {
  Date.now = realDateNow;
}
const emptyExpiryCalls = { count: 0 };
await maybeAttachClinicalFactsBackstop(expiredEmptyState, async (_system, _user, _signal, phase) => {
  if (phase === "extract") emptyExpiryCalls.count += 1;
  return JSON.stringify({ redFlags: [] });
});
ok("缓存生命周期: 空结果超过短 TTL 后强制重抽", emptyExpiryCalls.count === 1);

const populatedExtractedAtMs = realDateNow() - CLINICAL_FACTS_CACHE_TTL_MS - 1_000;
let expiredPopulatedState;
try {
  Date.now = () => populatedExtractedAtMs;
  expiredPopulatedState = await maybeAttachClinicalFactsBackstop({
    ...possibleState,
    id: "semantic-populated-ttl",
    clinicalFacts: undefined,
  }, async () => JSON.stringify({ redFlags: [{ category: "cardiac", subject: "patient", status: "possible", urgency: "clarify", triageBasis: "clarification_needed", quote: "说不清的压迫感" }] }));
} finally {
  Date.now = realDateNow;
}
const populatedExpiryCalls = { count: 0 };
await maybeAttachClinicalFactsBackstop(expiredPopulatedState, async (_system, _user, _signal, phase) => {
  if (phase === "extract") populatedExpiryCalls.count += 1;
  return JSON.stringify({ redFlags: [] });
});
ok("缓存生命周期: 有 finding 的结果超过 TTL 后强制重抽", populatedExpiryCalls.count === 1);

const timeoutState = await maybeAttachClinicalFactsBackstop({
  ...possibleState,
  id: "semantic-timeout",
  clinicalFacts: undefined,
}, async () => {
  const error = new Error("request timed out");
  error.name = "TimeoutError";
  throw error;
});
ok("运行时: timeout 显式标记 semantic unavailable/failure",
  timeoutState.clinicalFacts?.semanticStatus === "unavailable" &&
  timeoutState.clinicalFacts?.resultSource === "failure" &&
  timeoutState.clinicalFacts?.unavailableReason === "timeout");

const originalBackstopSetting = process.env.CDSS_CLINICAL_FACTS_BACKSTOP;
process.env.CDSS_CLINICAL_FACTS_BACKSTOP = "false";
const disabledState = await maybeAttachClinicalFactsBackstop({
  ...possibleState,
  id: "semantic-disabled",
  clinicalFacts: undefined,
});
if (originalBackstopSetting == null) delete process.env.CDSS_CLINICAL_FACTS_BACKSTOP;
else process.env.CDSS_CLINICAL_FACTS_BACKSTOP = originalBackstopSetting;
ok("信任边界: 显式关闭语义层仍形成 unavailable 剂量边界",
  disabledState.clinicalFacts?.semanticStatus === "unavailable" &&
  disabledState.clinicalFacts?.unavailableReason === "disabled" &&
  withSafetyGate(disabledState).safetyGate?.allowDosePrescription === false);

const abortController = new AbortController();
let receivedSignal;
await maybeAttachClinicalFactsBackstop({
  ...possibleState,
  id: "semantic-signal",
  clinicalFacts: undefined,
}, async (_system, _user, signal) => {
  receivedSignal = signal;
  return JSON.stringify({ redFlags: [] });
}, abortController.signal);
abortController.abort();
ok("运行时: 请求取消与总截止时间合并后仍会传递给模型调用",
  receivedSignal instanceof AbortSignal && receivedSignal.aborted);

const lateAbortController = new AbortController();
const lateAbortState = await maybeAttachClinicalFactsBackstop({
  ...possibleState,
  id: "semantic-late-abort",
  clinicalFacts: undefined,
}, async () => {
  lateAbortController.abort();
  return JSON.stringify({ redFlags: [{
    category: "cardiac",
    subject: "patient",
    status: "positive",
    urgency: "emergency",
    triageBasis: "other_immediate_threat",
    quote: "说不清的压迫感",
  }] });
}, lateAbortController.signal);
ok("信任边界: 请求取消后迟到的合法模型结果不得签成已核验事实",
  lateAbortState.clinicalFacts?.semanticStatus === "unavailable" &&
  lateAbortState.clinicalFacts?.resultSource === "failure" &&
  lateAbortState.clinicalFacts?.unavailableReason === "aborted" &&
  !lateAbortState.clinicalFacts?.attestation);

const forgedCacheCalls = { count: 0 };
await maybeAttachClinicalFactsBackstop({ ...possibleState, clinicalFacts: { ...possibleState.clinicalFacts, attestation: undefined } }, async (_system, _user, _signal, phase) => {
  if (phase === "extract") forgedCacheCalls.count += 1;
  return JSON.stringify({ redFlags: [] });
});
ok("信任边界: 无服务端证明的同指纹事实不能绕过模型复核", forgedCacheCalls.count === 1);

const changedAfterFailure = await maybeAttachClinicalFactsBackstop(
  { ...possibleState, chiefComplaint: "现已明确否认胸痛胸闷" },
  async () => { throw new Error("temporary outage"); },
);
ok("运行时: 病历变化且模型失败时不沿用陈旧红旗事实且显式不可用",
  changedAfterFailure.clinicalFacts?.redFlags.length === 0 && changedAfterFailure.clinicalFacts?.semanticStatus === "unavailable");

// —— 慢性基线 vs 急性升级（已知心衰/COPD/CKD 背景下的劳力性基线症状）——
const baselineEmergency = (category, triageBasis, quote) => JSON.stringify({
  redFlags: [{ category, subject: "patient", status: "positive", urgency: "emergency", triageBasis, quote }],
});

ok("底线: 劳力性基线 quote 达不到 emergency 证据底线，降级 urgent", (() => {
  const r = parseClinicalFacts(baselineEmergency("cardiac", "time_sensitive_cardiovascular_event", "平路气短"));
  return r?.redFlags.length === 1 && r.redFlags[0].urgency === "urgent" && r.redFlags[0].triageBasis === "urgent_review";
})());
ok("底线: 劳力限定+急性线索同在 quote 内仍可达 emergency", (() => {
  const r = parseClinicalFacts(baselineEmergency("cardiac", "time_sensitive_cardiovascular_event", "劳力性胸痛2年，今晨突发持续胸痛不缓解"));
  return r?.redFlags.length === 1 && r.redFlags[0].urgency === "emergency";
})());
ok("底线: 无劳力限定的急性 quote 不受基线规则影响", (() => {
  const r = parseClinicalFacts(baselineEmergency("respiratory", "airway_breathing_failure", "端坐呼吸"));
  return r?.redFlags.length === 1 && r.redFlags[0].urgency === "emergency";
})());

const baselineFacts = (category, triageBasis, quote) => ({
  redFlags: [{ category, subject: "patient", status: "positive", urgency: "emergency", triageBasis, quote }],
});
ok("消费层: 已知心衰背景的平路气短不升级为急性红旗，但保留优先复核提示", (() => {
  const text = "CKD 4期+HF EF35%，双下肢水肿，平路气短";
  const facts = baselineFacts("cardiac", "time_sensitive_cardiovascular_event", "平路气短");
  const adds = additiveRedFlagsFromFacts(facts, text, []);
  const advisories = semanticTriageAdvisoriesFromFacts(facts, text);
  return adds.length === 0 && advisories.length === 1 && /建议优先评估/.test(advisories[0]) && /平路气短/.test(advisories[0]);
})());
ok("消费层: 劳力性胸闷在稳定心绞痛背景下同样不升级", (() => {
  const text = "冠心病稳定型心绞痛，劳力性胸闷2年，规律服药";
  const facts = baselineFacts("cardiac", "time_sensitive_cardiovascular_event", "劳力性胸闷");
  return additiveRedFlagsFromFacts(facts, text, []).length === 0 &&
    semanticTriageAdvisoriesFromFacts(facts, text).length === 1;
})());
ok("消费层: 心衰+端坐呼吸必须升级为急性红旗", (() => {
  const text = "心衰EF35%，夜间端坐呼吸，不能平卧";
  const facts = baselineFacts("respiratory", "airway_breathing_failure", "端坐呼吸");
  return additiveRedFlagsFromFacts(facts, text, []).length === 1;
})());
ok("消费层: 基线 quote 所在句含急性线索时不得降级", (() => {
  const text = "HF EF35%，平路气短，昨夜突发不能平卧";
  const facts = baselineFacts("respiratory", "airway_breathing_failure", "平路气短");
  return additiveRedFlagsFromFacts(facts, text, []).length === 1;
})());
ok("消费层: 无劳力限定或无疾病背景的含混表述保守升级", (() => {
  const noDisease = baselineFacts("respiratory", "airway_breathing_failure", "平路气短");
  const noExertional = baselineFacts("respiratory", "airway_breathing_failure", "气短");
  return additiveRedFlagsFromFacts(noDisease, "平路气短", []).length === 1 &&
    additiveRedFlagsFromFacts(noExertional, "心衰EF35%，气短", []).length === 1;
})());
ok("消费层: 非心肺类目不受基线规则限制", (() => {
  const text = "慢阻肺，活动后腹痛3年";
  const facts = baselineFacts("acute_abdomen", "other_immediate_threat", "活动后腹痛");
  return additiveRedFlagsFromFacts(facts, text, []).length === 1;
})());

ok("grounding: 昨夜突发的急性事件按当前事件落地", (() => {
  const text = "心衰病史，昨夜突发夜间阵发性呼吸困难";
  const facts = baselineFacts("respiratory", "airway_breathing_failure", "夜间阵发性呼吸困难");
  return additiveRedFlagsFromFacts(facts, text, []).length === 1;
})());
ok("grounding: 远 past 锚点限定的突发仍是历史，不得复活", (() => {
  const text = "半年前曾突发右侧肢体无力，现已完全恢复，目前无不适";
  const facts = baselineFacts("neuro", "acute_neurologic_deficit", "右侧肢体无力");
  return additiveRedFlagsFromFacts(facts, text, []).length === 0;
})());
ok("grounding: 局部否定的变化线索（无加重）不构成急性覆盖", (() => {
  const text = "3年前确诊慢性胃炎，症状稳定无加重，目前复诊";
  const facts = baselineFacts("acute_abdomen", "other_immediate_threat", "症状稳定");
  return additiveRedFlagsFromFacts(facts, text, []).length === 0;
})());

ok("整类上限: 明确轻度腹痛且否认危险组合不得升为 urgent", (() => {
  const text = "腹痛不是很重，仍持续存在，没有反跳痛，也没发热呕吐";
  const facts = {
    redFlags: [{ category: "acute_abdomen", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "urgent_review", quote: "腹痛不是很重，仍持续存在" }],
  };
  const grounded = groundClinicalFacts(facts, text);
  return grounded.redFlags.length === 1 && grounded.redFlags[0].urgency === "clarify" &&
    grounded.redFlags[0].triageBasis === "clarification_needed";
})());

for (const [label, text] of [
  ["进行性加重", "腹痛虽然不是很重，但这两天越来越明显"],
  ["腹膜刺激征", "腹痛轻微，但按下去松手更疼"],
  ["显性出血", "轻度腹痛，同时排出黑便"],
]) {
  ok(`整类上限: 轻度描述同时存在${label}时不得降级`, (() => {
    const quote = text.slice(0, text.indexOf("，"));
    const facts = {
      redFlags: [{ category: "acute_abdomen", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "urgent_review", quote }],
    };
    return groundClinicalFacts(facts, text).redFlags[0]?.urgency === "urgent";
  })());
}

ok("整类上限: 39.x℃高热伴寒战但神志呼吸稳定不得升为 emergency", (() => {
  const text = "体温39.5℃，寒战，但神志清楚、呼吸平稳";
  const facts = {
    redFlags: [{ category: "sepsis", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "other_immediate_threat", quote: "体温39.5℃，寒战" }],
  };
  const grounded = groundClinicalFacts(facts, text);
  return grounded.redFlags[0]?.urgency === "urgent" && grounded.redFlags[0]?.triageBasis === "urgent_review";
})());

ok("整类上限: 39.x℃同时意识或呼吸异常时不得降级", (() => {
  const text = "体温39.5℃，寒战，意识模糊且呼吸困难";
  const facts = {
    redFlags: [{ category: "sepsis", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "other_immediate_threat", quote: "体温39.5℃，寒战" }],
  };
  return groundClinicalFacts(facts, text).redFlags[0]?.urgency === "emergency";
})());

ok("prompt: 提取提示含腹膜刺激征口语等价（松手更疼）必报 emergency 规则", (() => {
  const prompt = buildClinicalFactsExtractionPrompt("腹痛");
  return /松手更疼/.test(prompt) && /腹膜刺激征/.test(prompt) && /acute_abdomen \+ emergency/.test(prompt);
})());
ok("prompt: 提取提示保留劳力性基线不得标 emergency 规则", (() => {
  const prompt = buildClinicalFactsExtractionPrompt("气短");
  return /平路气短/.test(prompt) && /不得标 emergency/.test(prompt);
})());

ok("整类上限: 38.8℃发热伴寒战且稳定同样不得升为 emergency（消除39界限抖动）", (() => {
  const text = "体温38.8℃，寒战，神志清楚、呼吸平稳";
  const facts = {
    redFlags: [{ category: "sepsis", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "other_immediate_threat", quote: "体温38.8℃，寒战" }],
  };
  const grounded = groundClinicalFacts(facts, text);
  return grounded.redFlags[0]?.urgency === "urgent" && grounded.redFlags[0]?.triageBasis === "urgent_review";
})());

ok("整类上限: ≥40℃ 极高热不得降级", (() => {
  const text = "体温40.2℃，寒战，神志清楚、呼吸平稳";
  const facts = {
    redFlags: [{ category: "sepsis", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "other_immediate_threat", quote: "体温40.2℃，寒战" }],
  };
  return groundClinicalFacts(facts, text).redFlags[0]?.urgency === "emergency";
})());

ok("整类上限: 39.0℃伴意识模糊或低血压等受损表现不得降级", (() => {
  const text = "体温39.0℃，寒战，意识模糊，低血压";
  const facts = {
    redFlags: [{ category: "sepsis", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "other_immediate_threat", quote: "体温39.0℃，寒战" }],
  };
  return groundClinicalFacts(facts, text).redFlags[0]?.urgency === "emergency";
})());

ok("prompt: 提取与复核提示含发热分诊 ≥40℃/受损 原则线", (() => {
  const extract = buildClinicalFactsExtractionPrompt("发热");
  const review = buildClinicalFactsReviewPrompt("发热", { redFlags: [] });
  return /体温≥40℃/.test(extract) && /38–40℃/.test(extract) && /不得仅凭高热度数或寒战标 emergency/.test(extract) &&
    /未达40℃/.test(review) && /纠正为 urgent/.test(review);
})());

// —— T6 neuro benign-head-symptom cap（普通头痛头晕 clarify 收敛，但急症/后循环/急性起病一律保留）——
// 类级覆盖：整类普通头部症状同义词降级，且危险边界（治理 dangerExclusions + 急症 symptom + 急性起病）
// 任一命中即阻止降级。方向单调：只作用于 clarify，emergency/urgent 永不触碰。
{
  const neuroFinding = (quote, urgency) => ({
    semanticStatus: "checked",
    redFlags: [{ category: "neuro", subject: "patient", status: "positive", urgency,
      triageBasis: urgency === "emergency" ? "acute_neurologic_deficit" : "clarification_needed", quote }],
    encounterScope: { status: "active_current_target", quote },
    attestation: {},
  });
  const shown = (quote, urgency) => {
    const f = neuroFinding(quote, urgency);
    return semanticTriageAdvisoriesFromFacts(f, quote).length > 0 ||
      additiveRedFlagsFromFacts(f, quote, []).length > 0 ||
      priorityEvaluationItemsFromFacts(f, quote).length > 0;
  };
  // 整类普通头部症状（clarify）均应被抑制
  for (const q of ["头疼头晕，睡不着觉", "头晕", "眩晕，纳差便溏", "头痛头胀", "头昏沉", "头重脚轻，头晕"]) {
    ok(`neuro cap: 普通头部症状 clarify 抑制「${q}」`, shown(q, "clarify") === false);
  }
  // 危险边界任一命中：一律保留（漏放急症=0）
  ok("neuro cap: 雷击样剧烈头痛 emergency 保留", shown("突发雷击样剧烈头痛，伴意识改变", "emergency") === true);
  ok("neuro cap: 头晕伴复视（后循环）保留", shown("头晕伴复视、行走不稳", "clarify") === true);
  ok("neuro cap: 头痛伴言语不清（T6症状）保留", shown("头痛，言语不清", "clarify") === true);
  ok("neuro cap: 突发头晕（急性起病）保留", shown("突发头晕", "clarify") === true);
  ok("neuro cap: 头晕伴构音不清/吞咽困难 保留", shown("头晕，构音不清，饮水呛咳", "clarify") === true);
  ok("neuro cap: 头痛伴喷射性呕吐 保留", shown("头痛，喷射性呕吐", "clarify") === true);
  // 单调性：cap 绝不作用于 emergency/urgent（即便普通头晕词也不得因 cap 被抹除）
  ok("neuro cap: 普通头晕若被模型判 urgent 不被 cap 抹除", shown("头晕", "urgent") === true);
}

console.log(`\n${pass} passed`);
