/**
 * M03 本例说法核对（m03-patient-claim-check.server.ts，2026-10-19）与安全警示横幅列全红旗的断言。
 *
 * 核对器是窄核对小任务：模型交出「字段号 + 字段里逐字的片段」，服务端只做核对与最小删除。这里钉的是服务端那一半：
 *   P 解析：片段逐字在字段里；片段（去标点、中文数字换算后）是病历原文的一部分不删；缺项/鉴别意图说法不删；对照句里写别的病的不删；
 *     带「非」的对照不删；「有/伴+病历肯定写着的表现」不删；大半是病历原话的不删；西医鉴别里没有本例主语的不删
 *   R 删除：顿号并列项只删那一项；项首片段只删片段；否定字开头的片段删整项；「并/伴…」接上的末半句只删连接词和片段；其余删逗号分句；
 *     删空不删；标点收尾
 *   A 落实：片段已不在文中跳过；同样的删除做两遍结果相同；两次核对取交集；复核说写到了的不删；开关关闭不发请求
 *   B 横幅：每条不同的红旗都列出、去重、语义层红旗不带「原文依据」
 *   W 路由接线：两半都在既有收口的同一份输入上并行核对、在其结果上落实
 * 每条断言都跑过反证（见报告）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const SRC = process.env.R1019_SRC ? path.resolve(process.env.R1019_SRC) : path.resolve(process.cwd(), "src");
const jiti = createJiti(import.meta.url, {
  alias: { "@": SRC, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` },
});
const lib = (name) => jiti.import(path.join(SRC, "lib", name));

Object.assign(process.env, {
  AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", CDSS_SMALL_TASK_MEMO: "false",
});

const failures = [];
let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message.slice(0, 400) : String(error) });
  }
};

const claim = await lib("m03-patient-claim-check.server.ts");
const safety = await lib("diagnosis-safety.ts");

const RECORD = "性别：男；年龄：32岁\n恶寒发热、鼻塞流涕2天\n患者2天前淋雨后出现恶寒发热，恶寒重、发热轻，自测体温37.5℃，伴鼻塞、流清涕，稍有咳嗽，无汗。偶有心慌、胸痛。病程五天。";
const field = (id, text) => ({ id, text });
const parse = (claims, fields, record = RECORD) =>
  claim.parsePatientClaimRemovals(JSON.stringify({ claims }), fields, record) || [];

// ───── P 解析 ─────
await check("P1 片段逐字在字段里、且不是病历原文时才收；改了字、病历原话（含中文数字换算）不收", () => {
  const fields = [field("tcmDiseaseDifferentials[0].distinguishingPoints", "本例恶寒重、发热轻、口不渴、涕清，病程2天未见热势加重")];
  assert.deepEqual(parse([{ field: fields[0].id, span: "口不渴" }], fields), [{ field: fields[0].id, span: "口不渴" }]);
  assert.deepEqual(parse([{ field: fields[0].id, span: "口不干" }], fields), [], "字段里没有的片段不收");
  assert.deepEqual(parse([{ field: fields[0].id, span: "恶寒重" }], fields), [], "病历原文不收");
  assert.deepEqual(parse([{ field: "nope", span: "口不渴" }], fields), [], "字段号不在清单里不收");
  const days = [field("tcmDiseaseRationale", "本例病程5天，恶寒发热")];
  assert.deepEqual(parse([{ field: "tcmDiseaseRationale", span: "病程5天" }], days), [], "「病程五天」与「病程5天」是同一写法");
  assert.equal(claim.parsePatientClaimRemovals("not json", fields, RECORD), undefined);
});
await check("P2 缺项与鉴别意图说法不收（「未诉…」「需核实」「…需排除X」），顿号后别的项里的标记不算", () => {
  const fields = [
    field("a", "本例神志清楚，未诉急躁易怒、口苦，脉不弦"),
    field("b", "乏力、抽筋、月经紊乱需排除甲减"),
    field("c", "本例病程半年余、动则多汗，神志清、未诉肢冷"),
  ];
  assert.deepEqual(parse([{ field: "a", span: "口苦" }], fields), [], "「未诉」管到后面的顿号项");
  assert.deepEqual(parse([{ field: "b", span: "抽筋" }], fields), [], "句末「需排除」管整个分句");
  assert.deepEqual(parse([{ field: "c", span: "神志清" }], fields), [{ field: "c", span: "神志清" }], "后一项的「未诉」不管前一项");
});
await check("P3 对照句里写别的病的不收；带「非」的对照不收；「有/伴」+病历肯定写着的表现不收；否认句里的照收", () => {
  const fields = [
    field("tcmDiseaseRationale", "以肿物脱出为主症，故归内痔；脱肛为直肠黏膜全层脱出、色淡红，本例为肛内肿物脱出伴便血"),
    field("d", "本例以单侧灼痛为主而非瘙痒"),
    field("e", "有胸痛；未诉咯血"),
    field("f", "有汗出；病程两天"),
  ];
  assert.deepEqual(parse([{ field: "tcmDiseaseRationale", span: "色淡红" }], fields), [], "本例主语在片段之后");
  assert.deepEqual(parse([{ field: "d", span: "而非瘙痒" }], fields), []);
  assert.deepEqual(parse([{ field: "e", span: "有胸痛" }], fields), [], "病历「偶有心慌、胸痛」");
  assert.deepEqual(parse([{ field: "f", span: "有汗出" }], fields, "无汗出，病程两天"), [{ field: "f", span: "有汗出" }], "病历「无汗出」是否认，照收");
});
await check("P4 大半是病历原话的不收；西医鉴别里没有本例主语、也不以「有/伴」起头的不收", () => {
  const fields = [
    field("candidates", "鼻塞流清涕伴咽痛不适明显"),
    field("differentials[0].distinguishingPoints", "症状与进食体位相关、抗反流治疗有效"),
    field("differentials[1].distinguishingPoints", "本例为双侧隐痛、时发时止"),
    field("differentials[2].distinguishingPoints", "有胸闷但未记录反酸烧心，胸痛与情绪相关"),
  ];
  assert.deepEqual(parse([{ field: "candidates", span: "鼻塞流清涕伴咽痛" }], fields), [], "「鼻塞流清涕」是病历原话");
  assert.deepEqual(parse([{ field: "differentials[0].distinguishingPoints", span: "症状与进食体位相关" }], fields), []);
  assert.deepEqual(parse([{ field: "differentials[1].distinguishingPoints", span: "双侧隐痛" }], fields).length, 1);
  assert.deepEqual(parse([{ field: "differentials[2].distinguishingPoints", span: "胸痛与情绪相关" }], fields).length, 1);
});

// ───── R 删除 ─────
await check("R1 顿号并列：整项只删这一项；项首片段只删片段（判断接回前一项）；否定字开头的片段删整项", () => {
  assert.equal(claim.withoutClaimSpan("本例恶寒重、发热轻、口不渴、涕清，病程2天", "口不渴"), "本例恶寒重、发热轻、涕清，病程2天");
  assert.equal(claim.withoutClaimSpan("胁肋为肝胆之分野，痛剧、疱壁紧张属热毒壅于肝经，故为肝经郁热证", "疱壁紧张"),
    "胁肋为肝胆之分野，痛剧属热毒壅于肝经，故为肝经郁热证");
  assert.equal(claim.withoutClaimSpan("长期典型劳力相关胸闷胸痛史、明确冠心病诊断支持本病；本次加重需先排除急性冠脉综合征。", "劳力相关胸闷胸痛史"),
    "明确冠心病诊断支持本病；本次加重需先排除急性冠脉综合征。");
  assert.equal(claim.withoutClaimSpan("本例为隐痛酸软、无定处刺痛及外伤史，舌红不暗", "无定处刺痛"), "本例为隐痛酸软，舌红不暗",
    "只删「无定处刺痛」会剩「及外伤史」，把否认变成肯定");
});
await check("R2 「并/伴…」接上的末半句只删连接词和片段；其余删逗号分句；删空不删；标点收尾", () => {
  assert.equal(claim.withoutClaimSpan("老年女性，慢性胸闷乏力加重并放射至肩背，休息可缓解", "放射至肩背"), "老年女性，慢性胸闷乏力加重，休息可缓解");
  assert.equal(claim.withoutClaimSpan("本例肿物脱出不能还纳伴明显坠胀疼痛，病程半年", "坠胀疼痛"), "本例肿物脱出不能还纳，病程半年");
  assert.equal(claim.withoutClaimSpan("有胸闷但未记录反酸烧心，胸痛与情绪相关", "胸痛与情绪相关"), "有胸闷但未记录反酸烧心");
  assert.equal(claim.withoutClaimSpan("本例3月龄后起病，体重增长正常", "3月龄后起病"), "体重增长正常");
  assert.equal(claim.withoutClaimSpan("胸痛与情绪相关", "胸痛与情绪相关"), "胸痛与情绪相关", "删空不删");
  assert.equal(claim.withoutClaimSpan("D-二聚体升高；有胸痛；未诉咯血", "有胸痛"), "D-二聚体升高；未诉咯血");
  assert.equal(claim.withoutClaimSpan("故病性属郁热；簇集水疱、皮色鲜红为热毒外发。口苦咽干", "簇集水疱、皮色鲜红"), "故病性属郁热。口苦咽干");
  assert.equal(claim.withoutClaimSpan("文中没有", "口不渴"), "文中没有");
});

// ───── A 落实 ─────
const tcmRoot = () => ({
  overview: {
    tcmDiseaseRationale: "以恶寒发热、鼻塞流涕为主症，归感冒",
    tcmDiagnosticRationale: "恶寒重、发热轻、无汗，故属风寒束表证",
    tcmDiseaseDifferentials: [{ diseaseName: "风温", distinguishingPoints: "本例恶寒重、发热轻、口不渴、涕清，病程2天未见热势加重" }],
    tcmDifferentials: [{ syndrome: "风热犯表证", distinguishingPoints: "本例涕清、无汗" }],
  },
});
await check("A1 落实到一半的 JSON：只改命中的字段；片段已不在文中跳过；做两遍结果相同", () => {
  const removals = [{ field: "tcmDiseaseDifferentials[0].distinguishingPoints", span: "口不渴" }, { field: "tcmDiagnosticRationale", span: "不在文中" }];
  const once = claim.applyPatientClaimRemovalsToContent(JSON.stringify(tcmRoot()), "tcm", removals);
  const parsed = JSON.parse(once);
  assert.equal(parsed.overview.tcmDiseaseDifferentials[0].distinguishingPoints, "本例恶寒重、发热轻、涕清，病程2天未见热势加重");
  assert.equal(parsed.overview.tcmDiagnosticRationale, tcmRoot().overview.tcmDiagnosticRationale);
  assert.equal(claim.applyPatientClaimRemovalsToContent(once, "tcm", removals), once, "幂等");
  assert.equal(claim.applyPatientClaimRemovalsToContent("{bad", "tcm", removals), "{bad");
  assert.deepEqual(claim.patientClaimFields(tcmRoot(), "tcm").map((item) => item.id),
    ["tcmDiseaseRationale", "tcmDiagnosticRationale", "tcmDiseaseDifferentials[0].distinguishingPoints", "tcmDifferentials[0].distinguishingPoints"]);
  const western = { westernDiagnosis: { primary: { clinicalRationale: "依据" }, differentials: [{ name: "X", reason: "r", distinguishingPoints: "d" }], candidates: [{ name: "Y", keyEvidence: ["k"] }] } };
  assert.deepEqual(claim.patientClaimFields(western, "western").map((item) => item.id),
    ["primary.clinicalRationale", "differentials[0].reason", "differentials[0].distinguishingPoints"], "候选证据不核");
});
await check("A2 两次核对取交集（同字段、一个片段包含另一个，取较短）；复核判写到了的、漏答的不删", () => {
  const first = [{ field: "a", span: "口不渴" }, { field: "b", span: "双侧隐痛" }];
  const second = [{ field: "a", span: "口不渴、涕清" }, { field: "c", span: "双侧隐痛" }];
  assert.deepEqual(claim.agreedPatientClaimRemovals(first, second), [{ field: "a", span: "口不渴" }]);
  const supported = claim.parsePatientClaimVerification(JSON.stringify({ items: [{ id: 0, verdict: "absent" }, { id: 1, verdict: "supported", quote: "x" }, { id: 2, verdict: "partial" }] }), 4);
  assert.deepEqual([...supported].sort(), [1, 3], "1 判写到了、3 漏答都不删；0 没写、2 只写一部分照删");
  assert.equal(claim.parsePatientClaimVerification("oops", 2), undefined);
});
const savedFetch = globalThis.fetch;
const completion = (payload) => new Response(JSON.stringify({
  id: "t", object: "chat.completion", model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { "content-type": "application/json" } });
await check("A3 决定：两次核对并行、交集再复核；复核失败时一条都不删；开关关闭时不发请求", async () => {
  const content = JSON.stringify(tcmRoot());
  const bodies = [];
  let verifyReply = { items: [{ id: 0, verdict: "absent" }] };
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.messages[0].content.includes("你是病历核对员")) return verifyReply === null ? new Response("{}", { status: 500 }) : completion(verifyReply);
      return completion({ claims: [{ field: "tcmDiseaseDifferentials[0].distinguishingPoints", span: "口不渴" }] });
    };
    const removals = await claim.decidePatientClaimRemovals(content, { recordText: RECORD }, "tcm");
    assert.deepEqual(removals, [{ field: "tcmDiseaseDifferentials[0].distinguishingPoints", span: "口不渴" }]);
    assert.equal(bodies.filter((body) => body.messages[0].content.includes("你是病历事实核对器")).length, 2, "两次核对");
    const passes = bodies.filter((body) => body.messages[0].content.includes("你是病历事实核对器")).map((body) => JSON.parse(body.messages[1].content).fields.map((item) => item.id));
    assert.deepEqual(passes[1], [...passes[0]].reverse(), "第二次字段顺序反过来");
    verifyReply = { items: [{ id: 0, verdict: "supported", quote: "流清涕" }] };
    assert.deepEqual(await claim.decidePatientClaimRemovals(content, { recordText: `${RECORD}。` }, "tcm"), [], "复核判写到了");
    verifyReply = null;
    assert.deepEqual(await claim.decidePatientClaimRemovals(content, { recordText: `${RECORD}。。` }, "tcm"), [], "复核失败");
    bodies.length = 0;
    process.env.CDSS_M03_PATIENT_CLAIM_CHECK = "false";
    assert.deepEqual(await claim.decidePatientClaimRemovals(content, { recordText: RECORD }, "tcm"), []);
    assert.equal(bodies.length, 0, "关闭时不发请求");
  } finally {
    delete process.env.CDSS_M03_PATIENT_CLAIM_CHECK;
    globalThis.fetch = savedFetch;
  }
});
await check("A4 交给核对的病历首行补性别、年龄与带名称的生命体征", () => {
  assert.equal(claim.patientClaimRecordText("咳嗽3天", { sex: "女", age: 32 }, { P: "46", BP: "88/54" }),
    "性别：女；年龄：32岁；生命体征：脉搏/心率46，血压88/54\n咳嗽3天");
  assert.equal(claim.patientClaimRecordText("咳嗽3天", { age: "6个月" }), "年龄：6个月\n咳嗽3天");
  assert.equal(claim.patientClaimRecordText("咳嗽3天"), "咳嗽3天");
});

// ───── B 横幅 ─────
await check("B1 横幅列出每一条不同的红旗：去重、语义层红旗不带「原文依据」，其余措辞不变", () => {
  const banner = safety.buildSafetyAdvisoryBanner({
    status: "red_flag", redFlags: [
      "胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件",
      "现有表现提示急性中毒或药物过量可能，请立即核实暴露并急诊处置",
      "胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件",
      "现有资料提示需立即急诊评估（需排除：乌头碱中毒），原文依据：“自行用生草乌泡酒”",
    ], reasons: [],
  });
  assert.match(banner, /红旗提示：胸痛\/胸闷伴大汗、放射痛或气促，需排除急性心血管事件；现有表现提示急性中毒或药物过量可能，请立即核实暴露并急诊处置；现有资料提示需立即急诊评估（需排除：乌头碱中毒）\n/u);
  assert.equal((banner.match(/需排除急性心血管事件/gu) || []).length, 1, "去重");
  assert.doesNotMatch(banner, /原文依据/u);
  assert.match(banner, /安全警示（未解除，请医生优先处置）/u);
  assert.match(banner, /以下分析与方药供医生在处置上述风险之后参考，用药前请再次核对。/u);
});

// ───── W 路由接线 ─────
await check("W1 辨证路由：中医半与兼证一致并行、西医半与病名核对并行，都落在它们的结果上；确定性红旗病例的横幅并进语义层红旗", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/diagnosis/diagnose/route.ts"), "utf8");
  assert.match(route, /Promise\.all\(\[\s*reconcileSecondarySyndromes\(completed,[\s\S]{0,200}decidePatientClaimRemovals\(completed,[^)]*"tcm"/u);
  // 2026-10-22 第十五轮：兼证核对的结果先过证素核对（applyElementSupportDecision），本例说法核对仍落在它上面。
  // 2026-10-24 第十七轮：外面再套一层脱证提为主证（promoteCriticalSecondarySyndrome），落在三件核对之后。
  // 2026-10-27 第二十六轮：三件核对落定之后、提脱证之前，再补一次舌脉（reattributeStrandedKeyFindings，见 test:r1038-main 4.2）。
  assert.match(route, /reattributeStrandedKeyFindings\(\s*applyPatientClaimRemovalsToContent\(applyElementSupportDecision\(reconciled, elementDecision\), "tcm", claimRemovals\),/u);
  assert.match(route, /return promoteCriticalSecondarySyndrome\(reattributed\);/u);
  assert.match(route, /Promise\.all\(\[\s*alignWesternPrimaryAndName\([\s\S]{0,400}decidePatientClaimRemovals\(westernContent,[^)]*"western"/u);
  assert.match(route, /return applyPatientClaimRemovalsToContent\(aligned, "western", claimRemovals\)/u);
  assert.match(route, /patientClaimRecordText\(trustedInputText\(safeState\), safeState\.patient, safeState\.vitals\)/u);
  assert.match(route, /redFlags: \[\.\.\.gated\.safetyGate\.redFlags, \.\.\.semanticBannerFlags\]/u);
});

const summary = { suite: "r1019-claim-check", src: SRC, cases, failures };
console.log(JSON.stringify(summary, null, 1));
if (failures.length > 0) process.exitCode = 1;
