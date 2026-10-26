// 10/26 第二十一轮：按「读 / 判 / 查」分工从根上收口（四类遗留：C093 病机链清空、C075 儿童高热紫斑无红旗、
// 优先评估一律「3天内」、饮食不查食物过敏；外加两路读法不一致的注记与本系统急危重病名的一致性）。
//
//   1 引文对齐（source-quote-alignment.ts）：写法差异一处对齐、所有接地共用；否定与未评估语境守住。
//   2 病机链：对冲从句单独去掉、链将删空时用同一半已落地的主证依据补证候依据列、删除记账。
//   3 复诊时限：事实模型逐项给 timeWindow；乳腺两周路径结构化；ADA 2024 血糖 + 酮体两项 → 24 小时内。
//   4 指南红旗判别项：读病历结果 → 红旗 / 当天评估 / 提示；两路都失败给当面核对清单；精简表与源表同步。
//   5 两路读法不一致：红旗与剂量都保留，写明请先核实。
//   6 本系统西医主诊断为急危重病名而安全门无红旗时补报。
//   7 患者约束档案与推荐核对（过敏类别 × 饮食/饮片/中成药）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const align = await jiti.import("../src/lib/source-quote-alignment.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const facts = await jiti.import("../src/lib/clinical-facts.ts");
const verbatim = await jiti.import("../src/lib/verbatim-quote.ts");
const screen = await jiti.import("../src/lib/redflag-discriminator-screen.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const allergen = await jiti.import("../src/lib/allergen-profile.ts");
const required = await jiti.import("../src/lib/required-precautions.server.ts");

function pageCase({ sex = "女", age = 35, chief, present = "", detail = "", past = "", exams = "", tongue = "舌淡红，苔薄白", pulse = "脉细", medication = "未服药", allergy = "否认药物过敏",
  vitals = { T: "36.5", P: "78", R: "18", BP: "112/72" } } = {}) {
  const raw = [`患者信息：性别${sex}，年龄${age}岁`, `主诉：${chief}`, present && `现病史：${present}`, past && `既往史：${past}`, `过敏史：${allergy}`, `用药史：${medication}`,
    `生命体征/体格检查：T ${vitals.T}℃，P ${vitals.P}次/分，R ${vitals.R}次/分，BP ${vitals.BP}mmHg`, `舌象：${tongue}`, `脉象：${pulse}`, detail && `其他四诊/问诊补充：${detail}`, exams && `辅助检查：${exams}`].filter(Boolean).join("\n");
  return types.normalizeCaseStateInput({
    id: "r1033-test", phase: "collect", patient: { sex, age }, chiefComplaint: chief,
    symptoms: { ...(present ? { presentHistory: present } : {}), ...(detail ? { tcmDetail: detail } : {}), ...(exams ? { exams } : {}) },
    questionRounds: 0, maxQuestionRounds: 1, conversation: [{ role: "user", content: raw }],
    hisRecord: { schemaVersion: "tcm-cdss-his-v1", source: "tcm-cdss-his", caseId: "r1033-test", updatedAt: "2026-10-26T00:00:00.000Z", tongueImageUploaded: false,
      fields: { sex, age: String(age), zhushu: chief, xianbingshi: present, jiwangshi: past, guomin: allergy, yongyaoshi: medication, vitalsT: vitals.T, vitalsP: vitals.P, vitalsR: vitals.R, vitalsBP: vitals.BP, tcmTongue: tongue, tcmPulse: pulse, tcmDetail: detail, fuzhuJiancha: exams, tcmLineagePreference: "unrestricted" }, rawText: raw },
    tongue, pulse, pastHistory: past || undefined, medicationHistory: medication, allergyHistory: allergy, tcmLineagePreference: "unrestricted",
    vitals: { temperature: vitals.T, pulse: vitals.P, respiration: vitals.R, bloodPressure: vitals.BP },
  });
}
const withFacts = (state, clinicalFacts) => ({ ...state, clinicalFacts });

const C093_RECORD = "主诉：上腹痛3天\n现病史：患者口述腹痛“昨晚才开始”，又称三天前就因疼痛请假，时间线互相矛盾；无呕血。\n生命体征：BP 118/76mmHg\n舌象：舌淡红，苔白\n脉象：弦\n其他四诊/问诊补充：是否黑便尚未询问";

// ─── 1 引文对齐 ───────────────────────────────────────────────────────────────
await check("1.1 四诊字段写法对齐：「脉弦」「弦脉」「脉象：弦」都对回病历「脉象：弦」；「舌质淡红」对回「舌质：淡红」", () => {
  for (const quote of ["脉弦", "弦脉", "脉象：弦"]) {
    const aligned = align.alignQuoteToSource(quote, C093_RECORD);
    assert.equal(aligned?.span, "脉象：弦", quote);
    assert.equal(aligned?.status, "field_compact", quote);
  }
  assert.equal(align.alignQuoteToSource("舌质淡红", "舌质：淡红\n舌苔：薄白")?.span, "舌质：淡红");
  // 内容不同的不对齐：病历是弦，模型写滑；病历是上腹痛，模型写左上腹痛。
  assert.equal(align.alignQuoteToSource("脉滑", C093_RECORD), undefined);
  assert.equal(align.alignQuoteToSource("左上腹痛3天", C093_RECORD), undefined);
});

await check("1.2 归一化对齐：引号、中文数词与计量单位、拉丁字母单错（mmHp），返回的都是病历原文片段", () => {
  assert.equal(align.alignQuoteToSource("腹痛昨晚才开始", C093_RECORD)?.span, "腹痛“昨晚才开始”");
  assert.equal(align.alignQuoteToSource("上腹痛三天", C093_RECORD)?.span, "上腹痛3天");
  assert.equal(align.alignQuoteToSource("BP118/76mmHp", C093_RECORD)?.span, "BP 118/76mmHg");
  // 数字不同不算拉丁单错。
  assert.equal(align.alignQuoteToSource("BP 128/76mmHg", C093_RECORD), undefined);
});

await check("1.3 语境守卫：「是否黑便尚未询问」里的黑便不能当作肯定事实对齐（patientFactSourceQuote 照旧拒）", () => {
  assert.equal(contract.patientFactSourceQuote("黑便", C093_RECORD), undefined);
  assert.equal(contract.patientFactSourceQuote("脉弦", C093_RECORD), "脉象：弦");
  assert.equal(contract.patientFactSourceQuote("脉象：弦", C093_RECORD), "脉象：弦");
  // 窄核对引文：写法不同同样算出自病历。
  assert.ok(verbatim.quoteGroundedInText("脉弦舌淡红", "脉象：弦；舌象：舌淡红，苔白") || verbatim.quoteGroundedInText("BP118/76mmHp", C093_RECORD));
});

// ─── 2 病机链 ─────────────────────────────────────────────────────────────────
const S = "<!-- DIAGNOSIS_JSON_START -->";
const E = "<!-- DIAGNOSIS_JSON_END -->";
const chainOf = (content) => JSON.parse(content.slice(content.indexOf(S) + S.length, content.indexOf(E))).pathogenesis.chain;
const groundOne = (node, extra = {}, report) => chainOf(visible.groundStructuredPatientFacts(`${S}\n${JSON.stringify({ stage: "diagnose", ...extra, pathogenesis: { chain: [node] } })}\n${E}`, C093_RECORD, report));

await check("2.1 C093：唯一节点的证候依据写「脉弦」不再被删（链不再因此清空）", () => {
  const chain = groundOne({ patientFact: "上腹痛3天", syndromeEvidence: "脉弦", pathogenesis: "肝气郁结，横逆犯胃，胃失和降", therapyDirection: "疏肝理气，和胃止痛" });
  assert.equal(chain.length, 1);
  assert.equal(chain[0].syndromeEvidence, "脉象：弦");
});

await check("2.2 对冲从句单独去掉：「…，起病时间尚待核实」节点保留并去掉该从句；整句都是对冲的照旧删", () => {
  const events = [];
  const chain = groundOne({ patientFact: "上腹痛3天", syndromeEvidence: "舌淡红，苔白", pathogenesis: "肝气郁结，横逆犯胃，起病时间尚待核实", therapyDirection: "疏肝理气，和胃止痛" }, {}, (event) => events.push(event));
  assert.equal(chain.length, 1);
  assert.equal(chain[0].pathogenesis, "肝气郁结，横逆犯胃");
  assert.equal(events[0]?.trimmedHedges, 1);
  assert.equal(groundOne({ patientFact: "上腹痛3天", syndromeEvidence: "舌淡红，苔白", pathogenesis: "病机尚待进一步辨证", therapyDirection: "疏肝理气，和胃止痛" }).length, 0);
});

await check("2.3 链将删空：证候依据列没落地时，用同一半已落地的主证依据补上；删除按原因记账（不含原文）", () => {
  const events = [];
  const chain = groundOne(
    { patientFact: "上腹痛3天", syndromeEvidence: "脉沉迟", pathogenesis: "肝气郁结，横逆犯胃", therapyDirection: "疏肝理气，和胃止痛" },
    { overview: { primarySyndromeBasis: ["上腹痛3天", "舌淡红，苔白"] } },
    (event) => events.push(event),
  );
  assert.equal(chain.length, 1);
  assert.equal(chain[0].syndromeEvidence, "舌象：舌淡红，苔白");
  assert.equal(events[0].salvaged, 1);
  assert.deepEqual(events[0].dropped, { syndrome_evidence_ungrounded: 1 });
  assert.ok(!JSON.stringify(events).includes("上腹痛"), "记账不得带病历原文");
});

// ─── 3 事实层引文与复诊时限 ───────────────────────────────────────────────────
await check("3.1 事实层引文按写法对回原文（mmHp → mmHg）；阳性条目落在「尚未询问」处的不对齐", () => {
  const reanchored = facts.reanchorClinicalFactQuotes({
    redFlags: [
      { category: "cardiac", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "urgent_review", quote: "BP118/76mmHp" },
      { category: "gi_bleed", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "urgent_review", quote: "黑 便" },
    ],
  }, C093_RECORD, safety.recordMentionPolarityAt);
  assert.equal(reanchored.redFlags[0].quote, "BP 118/76mmHg");
  assert.equal(reanchored.redFlags[1].quote, "黑 便");
});

await check("3.2 事实模型逐项给评估时限（timeWindow），解析与「取最紧一档」", () => {
  const parsed = facts.parseClinicalFacts({ redFlags: [], disposition: { setting: "urgent_specialist", mustNotMiss: [
    { condition: "肝脏占位性病变", plausibility: "likely", evidenceQuotes: ["右上腹痛"], timeWindow: "within_2w" },
    { condition: "胆道感染", plausibility: "likely", evidenceQuotes: ["发热"], timeWindow: "within_24h" },
    { condition: "其他", plausibility: "likely", evidenceQuotes: ["右上腹痛"], timeWindow: "within_5d" },
  ] } });
  assert.deepEqual(parsed.disposition.mustNotMiss.map((item) => item.timeWindow), ["within_2w", "within_24h", undefined]);
  assert.equal(facts.dispositionPriorityWindowFromFacts(parsed, "右上腹痛，发热"), "within_24h");
  assert.match(facts.buildClinicalFactsExtractionPrompt("x"), /timeWindow/);
});

await check("3.3 复诊第一句按时限写：模型给 24 小时 → 「请在24小时内…」；乳房肿块仍是两周内乳腺专科（结构化，不按病名）；煎服节点同一计划", () => {
  const sepsis = { focus: "肝脓肿", window: "within_24h" };
  assert.equal(safety.priorityEvaluationFirstStep(sepsis), "请在24小时内到相关专科就诊，先完成评估（需排除肝脓肿），再按医生安排服药与复诊。");
  assert.equal(safety.priorityEvaluationFollowUpNode(sepsis, "完成5剂（5日）后复诊"), "先在24小时内到相关专科完成评估；医生确认可以服药后，完成5剂（5日）后复诊");
  const node = safety.priorityEvaluationFollowUpNode(sepsis, "完成5剂（5日）后复诊");
  assert.equal(safety.priorityEvaluationFollowUpNode(sepsis, node), node, "幂等");
  // 病名字符串不再决定路径：传「乳腺癌」字符串得到的是一般 3 天写法。
  assert.match(safety.priorityEvaluationFirstStep("乳腺癌"), /^请在3天内到相关专科就诊/);
  const lump = pageCase({ age: 38, chief: "左乳无痛性结节1个月", present: "洗澡时触及无痛肿块", detail: "妊娠状态明确否认", exams: "尚未乳腺超声" });
  assert.deepEqual(safety.priorityEvaluationFollowupTarget(lump), { focus: "乳腺癌", window: "within_2w", pathway: "breast_mass" });
});

await check("3.3b 处置去向与类目条目引同一句原文、不单列时，模型给的时限与要排除的情况挂到那条类目条目上（B006：24 小时内，不是 3 天内）", () => {
  const liver = pageCase({ sex: "男", age: 58, chief: "乏力伴间断发热1月", present: "间断性发热（最高体温38.5 °C），右上腹部压痛", exams: "不排除肝脓肿" });
  const facts = { semanticStatus: "checked", reviewStatus: "single_pass",
    redFlags: [{ category: "sepsis", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "urgent_review", quote: "间断性发热（最高体温38.5 °C）" }],
    disposition: { setting: "urgent_specialist", mustNotMiss: [{ condition: "肝脓肿", plausibility: "likely", evidenceQuotes: ["间断性发热（最高体温38.5 °C）"], timeWindow: "within_24h" }] } };
  const target = safety.priorityEvaluationFollowupTarget(withFacts(liver, facts));
  assert.deepEqual(target, { focus: "肝脓肿", window: "within_24h" });
  // 「可能」的必须排除项同样取时限（只定复诊多快，不定剂量；B010 疑似酮症酸中毒）。
  const possible = { ...facts, disposition: { ...facts.disposition, mustNotMiss: [{ ...facts.disposition.mustNotMiss[0], plausibility: "possible" }] } };
  assert.equal(safety.priorityEvaluationFollowupTarget(withFacts(liver, possible))?.window, "within_24h");
});

await check("3.4 ADA 2024 两项（血糖 ≥11.1 或已知糖尿病 + 尿酮 ≥2+ / 血酮 ≥3.0）→ 优先评估、24 小时内急诊查血气；尿酮 1+、既往读数不算", () => {
  const ketosis = pageCase({ sex: "男", age: 44, chief: "发现血糖增高4h", present: "口渴多饮", exams: "随机静脉血浆葡萄糖21.0 mmol/L；尿常规：尿糖(++++)，酮体(++)" });
  const target = safety.priorityEvaluationFollowupTarget(ketosis);
  assert.deepEqual(target, { focus: "糖尿病酮症酸中毒", window: "within_24h", pathway: "hyperglycemic_ketosis" });
  assert.match(safety.priorityEvaluationFirstStep(target), /^请在24小时内到医院急诊查血气与血酮/);
  const onePlus = pageCase({ sex: "男", age: 44, chief: "发现血糖增高4h", exams: "随机静脉血浆葡萄糖21.0 mmol/L；尿常规：酮体(+)" });
  assert.equal(safety.priorityEvaluationFollowupTarget(onePlus), undefined);
  const known = pageCase({ sex: "男", age: 60, chief: "乏力口干1周", past: "2型糖尿病10年", exams: "尿酮2+" });
  assert.equal(safety.priorityEvaluationFollowupTarget(known)?.pathway, "hyperglycemic_ketosis");
  const old = pageCase({ sex: "男", age: 60, chief: "乏力1周", exams: "既往血糖最高25 mmol/L；尿酮体(-)" });
  assert.equal(safety.priorityEvaluationFollowupTarget(old), undefined);
});

// ─── 4 指南红旗判别项 ─────────────────────────────────────────────────────────
const C075 = pageCase({ sex: "男", age: 4, chief: "高热伴皮疹2天", present: "高热39.5℃，精神差，身上出现紫红色按压不褪色斑点，口唇干，家长诉反应迟钝。", detail: "尿量明显减少；面象：嗜睡、皮肤紫癜样斑点",
  vitals: { T: "39.6", P: "152", R: "38", BP: "88/52" } });
const screenOf = (present) => ({ status: "checked", present });

await check("4.1 C075：读病历结果有按压不褪色皮疹、嗜睡 → 红旗（即使事实抽取超时）；只有生命体征时是当天评估 + 琥珀色提示、不升红旗", () => {
  const timedOut = { redFlags: [], semanticStatus: "unavailable", resultSource: "failure", unavailableReason: "timeout",
    discriminatorScreen: screenOf([{ conceptId: "ctx-fever", quote: "高热39.5℃" }, { conceptId: "non-blanching-rash", quote: "紫红色按压不褪色斑点" }, { conceptId: "does-not-wake", quote: "嗜睡" }]) };
  const gate = safety.evaluateSafetyGate(withFacts(C075, timedOut));
  assert.equal(gate.status, "red_flag");
  assert.ok(gate.redFlags.some((flag) => /按压不褪色的皮疹/.test(flag) && /NICE NG143/.test(flag)), JSON.stringify(gate.redFlags));
  const vitalsOnly = safety.evaluateSafetyGate(C075);
  assert.notEqual(vitalsOnly.status, "red_flag");
  assert.ok(vitalsOnly.missingItems.some((item) => /脓毒症高危指标/.test(item)), JSON.stringify(vitalsOnly.missingItems));
  assert.deepEqual(safety.priorityEvaluationFollowupTarget(C075), { focus: "脓毒症", window: "within_24h" });
  assert.ok((vitalsOnly.advisories || []).some((item) => /琥珀色征象/.test(item)));
});

await check("4.2 两路读病历都没返回：给这一年龄段的当面核对清单；处置不因清单改变", () => {
  const gate = safety.evaluateSafetyGate(withFacts(C075, { redFlags: [], semanticStatus: "unavailable", resultSource: "failure", unavailableReason: "timeout", discriminatorScreen: { status: "unavailable", present: [] } }));
  const checklist = (gate.advisories || []).find((item) => item.startsWith("指南红色征象的核对没有完成"));
  assert.ok(checklist && /按压不褪色的皮疹|叫不醒/.test(checklist), checklist);
});

await check("4.3 适用人群：成人不用五岁以下的表；无发热、无感染线索的儿童心率快不进脓毒症项；伪造的引文（病历里没有）不采信", () => {
  const adult = pageCase({ sex: "男", age: 30, chief: "咳嗽3天", present: "干咳", vitals: { T: "36.8", P: "96", R: "18", BP: "120/80" } });
  const adultGate = safety.evaluateSafetyGate(withFacts(adult, { redFlags: [], semanticStatus: "checked", discriminatorScreen: screenOf([{ conceptId: "non-blanching-rash", quote: "干咳" }]) }));
  assert.ok(!adultGate.redFlags.some((flag) => /NG143/.test(flag)));
  const afebrileChild = pageCase({ sex: "男", age: 4, chief: "哭闹半天", present: "跑跳后", vitals: { T: "36.8", P: "152", R: "24", BP: "95/60" } });
  const childGate = safety.evaluateSafetyGate(afebrileChild);
  assert.ok(!childGate.missingItems.some((item) => /脓毒症/.test(item)), JSON.stringify(childGate.missingItems));
  const forged = safety.evaluateSafetyGate(withFacts(C075, { redFlags: [], semanticStatus: "checked", discriminatorScreen: screenOf([{ conceptId: "grunting", quote: "呻吟样呼吸明显" }]) }));
  assert.ok(!forged.redFlags.some((flag) => /呻吟/.test(flag)));
});

await check("4.4 读病历结果的解析：清单外的 id、引文对不回病历、被否认或尚未询问的位置都丢弃", () => {
  // 注：「无皮疹，是否抽搐尚未询问，面色苍白」这一种写法里，安全层的否认读法把「无」读到了面色苍白（中间的「尚未询问」没截断），
  // 是第二十轮否认串规则的既有读法，本轮只记录（见本轮总结），这里用不跨否认串的写法。
  const record = "高热3天，面色苍白，无皮疹，是否抽搐尚未询问";
  const out = screen.parseRedflagDiscriminatorScreen(JSON.stringify({ present: [
    { id: "non-blanching-rash", quote: "皮疹" },
    { id: "status-epilepticus", quote: "抽搐" },
    { id: "pale-clinician", quote: "面色苍白" },
    { id: "not-in-list", quote: "高热3天" },
    { id: "ctx-fever", quote: "高热三天" },
  ] }), ["non-blanching-rash", "status-epilepticus", "pale-clinician", "ctx-fever"], record);
  assert.deepEqual(out, [{ conceptId: "pale-clinician", quote: "面色苍白" }, { conceptId: "ctx-fever", quote: "高热3天" }]);
  // 跨逗号的否认串不吞掉后面的阳性（「一天没怎么尿，身上皮肤发花」）；分句内的否认照旧排除。
  const elderly = "老人发烧后一天没怎么尿，身上皮肤发花";
  assert.deepEqual(screen.parseRedflagDiscriminatorScreen(JSON.stringify({ present: [{ id: "mottled-ashen", quote: "身上皮肤发花" }] }), ["mottled-ashen"], elderly), [{ conceptId: "mottled-ashen", quote: "身上皮肤发花" }]);
  // 语境判在引文终点：「家属诉患者此刻仍在抽搐」是患者本人的；「近18小时无尿」的否认是发现本身；「否认抽搐」照旧排除。
  const fitting = "家属诉患者此刻仍在抽搐，近18小时无尿，否认头痛";
  assert.deepEqual(screen.parseRedflagDiscriminatorScreen(JSON.stringify({ present: [
    { id: "currently-fitting", quote: "家属诉患者此刻仍在抽搐" }, { id: "no-urine-18h", quote: "近18小时无尿" }, { id: "focal-neuro-signs", quote: "否认头痛" },
  ] }), ["currently-fitting", "no-urine-18h", "focal-neuro-signs"], fitting).map((item) => item.conceptId), ["currently-fitting", "no-urine-18h"]);
  const request = screen.buildRedflagDiscriminatorRequest(record, { ageMonths: 48 });
  assert.ok(request.concepts.includes("non-blanching-rash") && request.concepts.includes("ctx-fever"));
  assert.ok(!screen.buildRedflagDiscriminatorRequest(record, { ageMonths: 40 * 12 }).concepts.includes("weak-high-pitched-cry"));
});

await check("4.5 精简运行时表与源表同步（node scripts/build-redflag-discriminators.mjs --check）", () => {
  const output = execFileSync(process.execPath, ["scripts/build-redflag-discriminators.mjs", "--check"], { encoding: "utf8" });
  assert.match(output, /"ok":true/);
});

// ─── 5 两路读法不一致 ─────────────────────────────────────────────────────────
await check("5.1 规则读出胸痛红旗、语义层对同一处原文读为否认：红旗与剂量都保留，写明请先核实；语义层肯定或只是急缓不同则不加", () => {
  const chest = pageCase({ sex: "男", age: 58, chief: "气短1天", present: "今晨突发胸痛伴大汗", vitals: { T: "36.6", P: "92", R: "20", BP: "130/80" } });
  const base = safety.evaluateSafetyGate(chest);
  assert.equal(base.status, "red_flag");
  const contrary = withFacts(chest, { redFlags: [{ category: "cardiac", subject: "patient", status: "negative", urgency: "routine", triageBasis: "routine_care", quote: "今晨突发胸痛伴大汗" }], semanticStatus: "checked", reviewStatus: "single_pass" });
  const noted = safety.evaluateSafetyGate(contrary);
  assert.equal(noted.status, "red_flag");
  assert.ok(noted.redFlags.some((flag) => flag.includes(safety.READER_DISAGREEMENT_NOTE_LEAD)), JSON.stringify(noted.redFlags));
  assert.equal(safety.derivePrescriptionPermission(contrary).candidateMode, "non_dose_only");
  const agreeing = withFacts(chest, { redFlags: [{ category: "cardiac", subject: "patient", status: "positive", urgency: "clarify", triageBasis: "clarification_needed", quote: "今晨突发胸痛伴大汗" }], semanticStatus: "checked", reviewStatus: "single_pass" });
  assert.ok(!safety.evaluateSafetyGate(agreeing).redFlags.some((flag) => flag.includes(safety.READER_DISAGREEMENT_NOTE_LEAD)));
});

// ─── 6 本系统急危重病名 ───────────────────────────────────────────────────────
await check("6.1 西医主诊断为确定的急危重病名（脓毒症伴感染性休克）而安全门无红旗：补报红旗；「待查」「既往」不算", () => {
  const plain = pageCase({ sex: "男", age: 50, chief: "发热咳嗽3天", present: "咳嗽咳痰", vitals: { T: "37.8", P: "96", R: "20", BP: "118/72" } });
  const withDx = (name) => ({ ...plain, reasoningDiagnose: { stage: "diagnose", westernDiagnosis: { primary: { name } } } });
  assert.equal(safety.evaluateSafetyGate(withDx("脓毒症伴感染性休克")).status, "red_flag");
  assert.ok(safety.evaluateSafetyGate(withDx("脓毒症伴感染性休克")).redFlags.some((flag) => flag.includes("急危重病「脓毒症伴感染性休克」")));
  assert.notEqual(safety.evaluateSafetyGate(withDx("脓毒症待查")).status, "red_flag");
  assert.notEqual(safety.evaluateSafetyGate(withDx("社区获得性肺炎")).status, "red_flag");
  assert.notEqual(safety.evaluateSafetyGate(withDx("陈旧性心肌梗死")).status, "red_flag");
});

// ─── 7 患者约束档案：过敏 ─────────────────────────────────────────────────────
const prescribeWithCare = ({ diet, precautions = [], treatments = [], medicines = [], herbs = [] } = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: {
    candidates: [{ name: "四君子汤加减", herbs, decoction: { doseCount: "7剂", course: "7日", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日1剂，水煎分2次温服", followUpNode: "完成7剂（7日）后复诊", followUpAfterDoses: 7, followUpAfterDays: 7 } }],
    patentAndWestern: medicines,
  },
  nonPharma: { diet, precautions, tcmTreatments: treatments },
  management: { followupSafetyNet: "请服完7剂药后（约7天后）复诊。" },
});

await check("7.1 病历过敏读成档案：过敏史一栏或带过敏提示的分句；否认、「过敏史：无」、蛋白质类药物不算；海鲜按总类展开", () => {
  const read = (text) => allergen.recordedAllergensInText(text, safety.clauseLocalMentionPolarityAt).map((item) => `${item.classId}:${item.kind}`);
  assert.deepEqual(read("过敏史：鸡蛋过敏"), ["egg:allergy"]);
  assert.deepEqual(read("过敏史：否认药物及食物过敏史"), []);
  assert.deepEqual(read("无鸡蛋过敏"), []);
  assert.deepEqual(read("过敏史：对蛋白质类药物过敏"), []);
  // 否认串不越过逗号：「否认药物过敏，鸡蛋过敏」里鸡蛋过敏照读；「否认鸡蛋、牛奶过敏」整句否认。
  assert.deepEqual(read("过敏史：否认药物过敏，鸡蛋过敏"), ["egg:allergy"]);
  assert.deepEqual(read("过敏史：否认鸡蛋、牛奶过敏"), []);
  assert.deepEqual(read("乳糖不耐受，喝牛奶腹泻"), ["milk:intolerance"]);
  const seafood = allergen.recordedAllergensInText("既往海鲜过敏", safety.recordMentionPolarityAt);
  const terms = allergen.allergenMatchesInText("可适量吃虾仁、鱼汤", seafood).map((item) => `${item.term}:${item.action}`);
  assert.ok(terms.includes("虾仁:avoid") && terms.includes("鱼汤:caution"), terms.join(","));
  // 形近词不算：蛋白质、鸡内金、鱼腥草、乳香。
  const egg = allergen.recordedAllergensInText("过敏史：鸡蛋过敏", safety.recordMentionPolarityAt);
  assert.deepEqual(allergen.allergenMatchesInText("多吃优质蛋白质，鸡内金研粉", egg), []);
});

await check("7.2 B061：病历记录鸡蛋过敏 → 必写注意事项含过敏一条；饮食段删掉蒸蛋那一项、食疗卡含蛋的不出、其余照留；再投影逐字不变", () => {
  const state = pageCase({ age: 70, chief: "纳差乏力1月", present: "食少便溏", allergy: "鸡蛋过敏" });
  const items = required.requiredPrecautionsForCase(state, null);
  const item = items.find((entry) => entry.kind === "food_allergy");
  assert.ok(item && item.classes.some((entry) => entry.classId === "egg"), JSON.stringify(items.map((entry) => entry.kind)));
  const reasoning = prescribeWithCare({
    diet: "宜清淡易消化，可食山药小米粥、蒸蛋，忌生冷油腻。",
    treatments: [{ projectCode: "diet_therapy", projectName: "食疗", treatmentContent: "枸杞蒸蛋，每周两次" }, { projectCode: "diet_therapy", projectName: "食疗", treatmentContent: "山药莲子粥" }],
  });
  const once = surface.projectDeliveredReasoning(reasoning, { requiredPrecautions: items });
  assert.ok(!once.nonPharma.diet.includes("蒸蛋") && once.nonPharma.diet.includes("小米粥"), once.nonPharma.diet);
  assert.deepEqual(once.nonPharma.tcmTreatments.map((card) => card.treatmentContent), ["山药莲子粥"]);
  assert.ok(once.nonPharma.precautions.some((line) => /过敏/.test(line) && /蛋/.test(line)), JSON.stringify(once.nonPharma.precautions));
  assert.deepEqual(surface.projectDeliveredReasoning(once, { requiredPrecautions: items }), once, "不幂等");
});

await check("7.3 饮片与加减：过敏原同源的 avoid 档饮片（鸡子黄、蜜炙）进方 → 修复轮删除（人群 HIGH 同一出口）；caution 档不驱动修复；无过敏不拦", () => {
  const eggContext = "过敏史：鸡蛋过敏\n主诉：心烦失眠1月";
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "黄连" }, { name: "鸡子黄" }], eggContext), "herb_1_special_population_high_risk_allergy");
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "黄连" }, { name: "鸡子黄" }], "过敏史：否认\n主诉：心烦失眠1月"), undefined);
  const honeyContext = "过敏史：蜂蜜过敏\n主诉：咳嗽2周";
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "炙甘草" }], honeyContext), "herb_0_special_population_high_risk_allergy");
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "甘草" }, { name: "蜜蒙花" }, { name: "炙淫羊藿" }], honeyContext), undefined);
  const shell = allergen.recordedAllergensInText("过敏史：海鲜过敏", safety.recordMentionPolarityAt);
  assert.equal(allergen.allergenHerbMatch("牡蛎", shell)?.action, "caution");
});

await check("7.4 中成药：名称或成份含过敏原（avoid 档）的不推荐；不含的照留", () => {
  const items = [{ kind: "food_allergy", classes: [{ classId: "bee_products", labelZh: "蜂蜜及蜂产品", kind: "allergy", quote: "蜂蜜过敏" }] }];
  const once = surface.projectDeliveredReasoning(prescribeWithCare({
    diet: "宜清淡。",
    medicines: [{ type: "中成药", name: "蜂胶口服液", correspondingProblem: "咳嗽" }, { type: "中成药", name: "急支糖浆", correspondingProblem: "咳嗽" }],
  }), { requiredPrecautions: items });
  assert.deepEqual(once.formula.patentAndWestern.map((item) => item.name), ["急支糖浆"]);
});

await check("7.5 精简过敏分类表与源表同步；读病历小任务的清单带上各类「对X过敏」，读出的结果并入档案", () => {
  const output = execFileSync(process.execPath, ["scripts/build-allergen-classes.mjs", "--check"], { encoding: "utf8" });
  assert.match(output, /"ok":true/);
  const request = screen.buildRedflagDiscriminatorRequest("过敏史：吃虾后起风团", { ageMonths: 40 * 12 });
  assert.ok(request.concepts.includes("allergy-crustacean"));
  const parsed = screen.parseRedflagDiscriminatorScreen(JSON.stringify({ present: [{ id: "allergy-crustacean", quote: "吃虾后起风团" }] }), request.concepts, "过敏史：吃虾后起风团");
  assert.deepEqual(allergen.allergensFromScreen(parsed).map((item) => item.classId), ["crustacean"]);
});

console.log(`r1033-main: ${cases} checks`);
