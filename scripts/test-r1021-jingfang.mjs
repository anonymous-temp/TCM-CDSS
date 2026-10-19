// 10/19 第九轮 WP9-A（2026-10-19 晚）：经方方证通道校准。
//
// 背景：第八轮的经方方证候选通道没有让 X 集中医诊断提升（70.0 → 69.1）。X 集 17 例标准答案是方证的病例，离线重放闭集选择：
// 选对 5、选错 1、空 11；选对的 5 例里 M03 只采用 1 例（教材行「大致贴合」就弃用方证）。逐例拆开后，空选的原因是：
//   · 同一段原话写了两个主症（「伴恶风,汗出」「汗出恶风」「发热口渴」），被「同一段原话只算一条」拦掉一个；
//   · 引文以「不」起头的症状本身（「不大便三日，腹胀不适」）被当成否认；
//   · 桂枝汤证的汗出+发热、桂枝去芍药汤证的脉促+胸满：每个症状单看都很常见，特异度之和凑不到下限，合在一起却正是一条原文；
//   · 核对是二元的，对「突感脐部跳动」对「脐下悸」这类部位说法差别极敏感，同一批证据对换个批次组成判定就会翻；
//   · 红旗病例（乌头药酒中毒的心律失常）被包装成炙甘草汤证。
//
//   1 引文解析：同一段原话逐字含两个症状时各算一条；含一个症状的不重复算（对照）；以否定字起头的症状本身不是否认（对照：不口渴、没有出汗仍是否认）
//   2 够不够：条文内互证（同一条原文里的两个以上已确认主症，且只有这一个方证能全部覆盖）；对照：不同条文里各一个常见症状、几个方证都能覆盖、只有泛症
//   3 三档核对：same/close/different 的解析；close 只在同一方证有 same 时确认，舌脉症状不接受 close；close 在提示词里写「近似」
//   4 红旗病例不出方证候选（对照：非红旗照常调用）
//   5 回放：真实模型的记录输出（X 集考试病例，真实 deepseek-flash 2026-10-19）按现行规则重算
//   6 M03 段落：教材行与方证都贴合时比较区分点（不再是「教材行贴合就弃用方证」）
//
// 反证记录在 ~/runlogs/r1018/work/r1019/counterproofs.txt（前缀 9/jingfang/）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const jp = await jiti.import("../src/lib/jingfang-patterns.ts");
const pick = await jiti.import("../src/lib/jingfang-pattern-pick.server.ts");
const prompts = await jiti.import("../src/lib/diagnosis-prompts.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const memo = await jiti.import("../src/lib/small-task-memo.server.ts");

const P = (name) => jp.jingfangPatternByName(name);
const ev = (...symptoms) => symptoms.map((symptom) => ({ symptom, quote: symptom }));
const evidenceOf = (list) => ({ patterns: list });
const parseWith = (record, pattern, evidence) => pick.parseJingfangCandidates(JSON.stringify(evidenceOf([{ pattern, evidence }])), record);

// ───────────────────────────── 1 引文解析 ─────────────────────────────

await check("1.1 同一段原话逐字写了两个症状（伴恶风,汗出）时各算一条证据；对照：原话里只逐字含一个症状的，同一段原话不重复算（一句话不能被对到几个症状上凑条数）", () => {
  const record = "主诉：素易感冒\n现病史：素易感冒。此次低热3天，伴恶风,汗出,鼻塞,干呕，二便调，舌淡苔薄，脉弱。";
  const shared = parseWith(record, "桂枝汤证", [
    { quote: "伴恶风,汗出", symptom: "恶风" }, { quote: "伴恶风,汗出", symptom: "汗出" }, { quote: "干呕", symptom: "干呕" },
  ]);
  assert.deepEqual(shared[0].evidence.map((item) => item.symptom), ["恶风", "汗出", "干呕"], "两个症状在原话里都逐字出现，各算一条");
  // 对照 A：原话只逐字含其中一个症状（「腹部硬满疼痛拒按」里既没有「从心下至少腹硬满而痛不可近」也没有「心下硬痛拒按」）：第二条不算
  const record2 = "主诉：不大便四天\n现病史：不大便四天。伴发热下午稍有增高，腹部硬满疼痛拒按，口渴。";
  const single = parseWith(record2, "大陷胸汤证", [
    { quote: "腹部硬满疼痛拒按", symptom: "从心下至少腹硬满而痛不可近" }, { quote: "腹部硬满疼痛拒按", symptom: "心下硬痛拒按" }, { quote: "口渴", symptom: "口渴" },
  ]);
  assert.deepEqual(single[0].evidence.map((item) => item.symptom), ["从心下至少腹硬满而痛不可近", "口渴"], "一段原话没有逐字写出第二个症状时不重复算");
  // 对照 B：同一症状不重复；另一段原话正常
  const dupSymptom = parseWith(record, "桂枝汤证", [{ quote: "伴恶风,汗出", symptom: "汗出" }, { quote: "汗出", symptom: "汗出" }, { quote: "干呕", symptom: "干呕" }]);
  assert.deepEqual(dupSymptom[0].evidence.map((item) => item.symptom), ["汗出", "干呕"], "同一症状不重复");
});

await check("1.2 以「不」起头的症状本身（不大便三日）不是否认；对照：不口渴、没有出汗仍是否认；症状本身是否定写法时引文须同样带否定字", () => {
  const record = "主诉：身黄、不大便三日\n现病史：一周前发热，刻下身黄，小便色如红茶，不大便三日，腹胀不适，也不口渴，没有出汗。";
  const lexical = parseWith(record, "茵陈蒿汤证", [{ quote: "不大便三日，腹胀不适", symptom: "腹微满" }, { quote: "刻下身黄", symptom: "身黄如橘子色" }]);
  assert.deepEqual(lexical[0].evidence.map((item) => item.symptom), ["腹微满", "身黄如橘子色"], "「不大便三日…」是症状，不是否认");
  assert.equal(parseWith(record, "白头翁汤证", [{ quote: "不口渴", symptom: "口渴" }]).length, 0, "不口渴 是否认（表里没有以「不口渴」起头的症状）");
  assert.equal(parseWith(record, "桂枝汤证", [{ quote: "没有出汗", symptom: "汗出" }]).length, 0, "没有出汗 是否认");
  // 症状本身是否定写法（不大便五六日）：引文「不大便三日」带同样的否定字，保留
  const negSymptom = parseWith(record, "大承气汤证", [{ quote: "不大便三日", symptom: "不大便五六日" }, { quote: "腹胀不适", symptom: "腹满而喘" }]);
  assert.equal(negSymptom[0].evidence[0].symptom, "不大便五六日");
  // 表自己当词表：以「不」起头的症状确有其词
  assert.equal(jp.jingfangSymptomStartsWith("不大便"), true);
  assert.equal(jp.jingfangSymptomStartsWith("不口渴"), false);
});

// ───────────────────────────── 2 够不够 ─────────────────────────────

await check("2.1 条文内互证：同一条原文里的两个以上已确认主症（桂枝去芍药汤证的脉促+胸满、大陷胸汤证的不大便+硬满痛不可近）且只有这个方证能全部覆盖时够；第二个方证不适用", () => {
  const ok = pick.jingfangEvidenceSufficient;
  assert.equal(ok(P("桂枝去芍药汤证"), ev("脉促", "胸满"), true), true, "脉促+胸满 是第 21 条的原文症状组");
  assert.equal(ok(P("桂枝去芍药汤证"), ev("脉促", "胸满"), false), false, "第二个方证仍要 3 条");
  assert.equal(ok(P("大陷胸汤证"), ev("不大便", "从心下至少腹硬满而痛不可近", "口渴"), true), true);
  // 第九轮之前这两组都因特异度之和低于阈值而不够：
  assert.ok(jp.jingfangSymptomSpecificity("脉促") + jp.jingfangSymptomSpecificity("胸满") < jp.JINGFANG_MIN_SPECIFICITY);
  assert.ok(["不大便", "从心下至少腹硬满而痛不可近", "口渴"].reduce((sum, item) => sum + jp.jingfangSymptomSpecificity(item), 0) < jp.JINGFANG_MIN_SPECIFICITY);
});

await check("2.2 条文内互证的对照：不同条文里各一个常见症状（真武汤证的头眩+自下利）不算；几个方证都能覆盖这组证据（恶寒+无汗+脉浮紧）不推给 M03；只有泛症（发热+头痛）不算", () => {
  const ok = pick.jingfangEvidenceSufficient;
  assert.equal(jp.jingfangClauseCooccurrence(P("真武汤证"), ["头眩", "自下利"]).count, 1, "头眩与自下利不在同一条原文里");
  assert.equal(ok(P("真武汤证"), ev("头眩", "自下利"), true), false);
  const tie = jp.jingfangPatternsCovering(["恶寒", "无汗", "脉浮紧"]);
  assert.ok(["麻黄汤证", "葛根汤证", "大青龙汤证"].every((name) => tie.includes(name)), `这组证据三个方证都能覆盖：${tie.join("、")}`);
  assert.equal(jp.jingfangClauseCooccurrence(P("麻黄汤证"), ["无汗", "脉浮紧"]).count >= 2, true, "无汗+脉浮紧 确在同一条原文里");
  assert.equal(ok(P("麻黄汤证"), ev("恶寒", "无汗", "脉浮紧"), true), false, "条文内互证成立，但分不出是哪个方证");
  assert.equal(ok(P("桂枝汤证"), ev("发热", "头痛"), true), false, "只有泛症");
  assert.deepEqual(jp.jingfangPatternsCovering(["脉促", "胸满"]), ["桂枝去芍药汤证"], "脉促+胸满 只有桂枝去芍药汤证能覆盖");
  assert.deepEqual(jp.jingfangPatternsCovering([]), []);
  // 条文内最多的一组
  const group = jp.jingfangClauseCooccurrence(P("桂枝去芍药汤证"), ["脉促", "胸满", "恶风寒"]);
  assert.deepEqual(group.symptoms.sort(), ["胸满", "脉促"].sort());
});

await check("2.3 含「近似」证据时至少要 3 个不同主症（一条逐字加一条近似不够）；对照：同样两条都是逐字的够，三条含近似的够，近似只是第三条补充的够", () => {
  const ok = pick.jingfangEvidenceSufficient;
  const exact = (symptom) => ({ symptom, quote: symptom });
  const approx = (symptom) => ({ symptom, quote: symptom, approximate: true });
  // 肾气丸证：小便反多（只在消渴相关方证里）+ 虚劳腰痛
  assert.equal(ok(P("肾气丸证"), [exact("小便反多"), exact("虚劳腰痛")], true), true, "两条逐字：特异度够");
  assert.equal(ok(P("肾气丸证"), [exact("小便反多"), approx("虚劳腰痛")], true), false, "一条逐字加一条近似：不够");
  assert.equal(ok(P("肾气丸证"), [exact("小便反多"), approx("虚劳腰痛"), exact("消渴")], true), true, "第三条逐字补上后够");
  assert.equal(ok(P("半夏厚朴汤证"), [approx("咽中如有炙脔")], true), false, "单症方证只有近似证据不够");
  assert.equal(ok(P("半夏厚朴汤证"), [exact("咽中如有炙脔")], true), true);
});

// ───────────────────────────── 3 三档核对 ─────────────────────────────

await check("3.1 核对结果解析：same=2、close=1、其余/缺项/越界/非法=0；兼容旧格式 {same:true}；旧的布尔接口只认 same", () => {
  const content = JSON.stringify({ verdicts: [{ id: 1, match: "same" }, { id: 2, match: "close" }, { id: 3, match: "different" }, { id: 5, match: "same" }, { id: 4, match: "不知道" }] });
  assert.deepEqual(pick.parseJingfangEvidenceGrades(content, 4), [2, 1, 0, 0]);
  assert.deepEqual(pick.parseJingfangEvidenceGrades(JSON.stringify({ verdicts: [{ id: 1, same: true }, { id: 2, same: "yes" }] }), 2), [2, 0], "旧格式");
  assert.deepEqual(pick.parseJingfangEvidenceGrades("坏的", 2), [0, 0]);
  assert.deepEqual(pick.parseJingfangEvidenceGrades(null, 2), [0, 0]);
  assert.deepEqual(pick.parseJingfangEvidenceVerdicts(content, 3), [true, false, false], "布尔接口只认 same");
});

await check("3.2 close 的使用：同一方证里至少有一条 same 时才确认；全是 close 不确认；舌脉症状不接受 close；差得远的（different）永远不确认", () => {
  const record = "主诉：胸闷\n现病史：下之后胸闷，脉促，恶寒发热未除，舌淡苔白润。";
  const cands = pick.parseJingfangCandidates(JSON.stringify(evidenceOf([{ pattern: "桂枝去芍药汤证", evidence: [
    { quote: "胸闷", symptom: "胸满" }, { quote: "脉促", symptom: "脉促" }, { quote: "恶寒发热未除", symptom: "恶风寒" },
  ] }])), record);
  assert.equal(cands[0].evidence.length, 3);
  assert.deepEqual(pick.jingfangVerifiedFromGrades(cands, [1, 2, 1]), [true, true, true], "有 same 作锚，close 确认");
  assert.deepEqual(pick.jingfangVerifiedFromGrades(cands, [1, 1, 1]), [false, false, false], "全是 close 不确认");
  assert.deepEqual(pick.jingfangVerifiedFromGrades(cands, [1, 2, 0]), [true, true, false], "different 不确认");
  // 舌脉症状不接受 close（脉促对「脉弦而结」那样的近似不算）：脉促判 close、胸满判 same
  assert.deepEqual(pick.jingfangVerifiedFromGrades(cands, [2, 1, 0]), [true, false, false], "脉象症状 close 不确认");
  const tongue = pick.parseJingfangCandidates(JSON.stringify(evidenceOf([{ pattern: "半夏散及汤证", evidence: [
    { quote: "咽喉疼痛", symptom: "咽中痛" }, { quote: "苔白润", symptom: "舌淡苔润" },
  ] }])), "主诉：咽痛\n现病史：咽喉疼痛，舌质淡，苔白润。");
  assert.deepEqual(pick.jingfangVerifiedFromGrades(tongue, [2, 1]), [true, false], "舌象症状 close 不确认");
  assert.deepEqual(pick.jingfangVerifiedFromGrades(tongue, [2, 2]), [true, true], "对照：舌象 same 确认");
  // 多个候选按各自的锚判断
  const two = [cands[0], tongue[0]];
  assert.deepEqual(pick.jingfangVerifiedFromGrades(two, [1, 1, 1, 2, 1]), [false, false, false, true, false]);
});

await check("3.3 close 标「近似」：finalize 后的证据带 approximate；M03 提示词里写「近似」而不是「≈」；same 仍写「≈」", () => {
  const record = "主诉：突感脐部跳动\n现病史：生气后突感脐部跳动，继之有物上冲，状如奔豚，小便不利，量少。";
  const cands = pick.parseJingfangCandidates(JSON.stringify(evidenceOf([{ pattern: "茯苓桂枝甘草大枣汤证", evidence: [
    { quote: "突感脐部跳动", symptom: "脐下悸" }, { quote: "状如奔豚", symptom: "欲作奔豚" }, { quote: "小便不利，量少", symptom: "小便不利" },
  ] }])), record);
  const grades = [1, 2, 2];
  const marked = pick.jingfangMarkApproximate(cands, grades);
  assert.equal(marked[0].evidence[0].approximate, true);
  assert.equal(marked[0].evidence[1].approximate, undefined);
  assert.equal(marked[0].evidence[2].approximate, undefined);
  assert.equal(cands[0].evidence[0].approximate, undefined, "不改入参");
  const picks = pick.finalizeJingfangPicks(marked, pick.jingfangVerifiedFromGrades(cands, grades));
  assert.deepEqual(picks.map((item) => item.patternName), ["茯苓桂枝甘草大枣汤证"]);
  const text = jp.buildJingfangCandidateContext(picks);
  assert.ok(text.includes("病历「突感脐部跳动」近似脐下悸；病历「状如奔豚」≈欲作奔豚；病历「小便不利，量少」≈小便不利"), text.slice(0, 400));
});

await check("3.4 提示词：第一次调用先找最特异的表现并允许一段原话对两个主症、要求相邻完整说法；核对调用是三档、不给方证名", () => {
  const state = types.normalizeCaseStateInput({ id: "jf-msg", chiefComplaint: "怕风、出汗2天", patient: { sex: "男", age: 35 }, symptoms: { 现病史: "出汗多，一吹风就觉得冷。" }, conversation: [] });
  const first = pick.buildJingfangPickMessages(state, "主诉：怕风").map((message) => message.content).join("\n");
  assert.ok(first.includes("先在病历里找最特异的表现"));
  assert.ok(first.includes("不要从发热、恶寒、汗出、口渴、腹泻、头痛这类很多方证共有的表现开始凑"));
  assert.ok(first.includes("原文里同一小段确实写了两个主症"));
  assert.ok(first.includes("quote 要取病历里相邻的完整说法"));
  const second = pick.buildJingfangEvidenceCheckMessages([{ quote: "出汗多", symptom: "汗出" }]).map((message) => message.content).join("\n");
  assert.ok(second.includes("same：") && second.includes("close：") && second.includes("different："));
  assert.ok(second.includes('"match":"same"'));
  assert.ok(!/桂枝汤|太阳中风/u.test(second), "核对调用不含方证名");
});

// ───────────────────────────── 4 红旗 ─────────────────────────────

await check("4.1 红旗病例不出方证候选（不发任何模型请求）；对照：同一份病历非红旗时照常调用", async () => {
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.deepseek.com",
    OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", CDSS_SMALL_TASK_MEMO: "true",
  });
  delete process.env.CDSS_JINGFANG_PATTERN_PICK;
  memo.resetSmallTaskMemoForTests();
  const bodies = [];
  const reply = (content) => new Response(JSON.stringify({ id: "t", object: "chat.completion", model: "deepseek-flash", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.messages[0].content.includes("症状对应核对器")) {
      const input = JSON.parse(body.messages[1].content);
      return reply(JSON.stringify({ verdicts: input.pairs.map((pair) => ({ id: pair.id, match: "same" })) }));
    }
    return reply(JSON.stringify(evidenceOf([{ pattern: "炙甘草汤证", evidence: [{ quote: "脉结代", symptom: "脉结代" }, { quote: "自觉心跳不齐", symptom: "心动悸" }] }])));
  };
  try {
    const base = types.normalizeCaseStateInput({ id: "jf-rf", chiefComplaint: "饮药酒后心慌", patient: { sex: "男", age: 50 }, symptoms: { 现病史: "饮自泡乌头药酒后心慌，自觉心跳不齐，口唇麻木。" }, pulse: "脉结代", conversation: [] });
    const flagged = { ...base, safetyGate: { status: "red_flag", allowDiagnosis: true, allowDosePrescription: false, redFlags: ["乌头类药物中毒"], missingItems: [], reasons: [] } };
    assert.deepEqual(await pick.pickJingfangPatternsForCase(flagged), []);
    assert.equal(bodies.length, 0, "红旗病例不发请求");
    const normal = { ...base, safetyGate: { status: "needs_information", allowDiagnosis: true, allowDosePrescription: true, redFlags: [], missingItems: [], reasons: [] } };
    const picks = await pick.pickJingfangPatternsForCase(normal);
    assert.deepEqual(picks.map((item) => item.patternName), ["炙甘草汤证"], "非红旗照常选出");
    assert.equal(bodies.length, 2);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    memo.resetSmallTaskMemoForTests();
  }
});

// ───────────────────────────── 5 回放 ─────────────────────────────

const RECORDED = JSON.parse(readFileSync(new URL("./fixtures/jingfang-r1021-recorded.json", import.meta.url), "utf8"));
const replay = (item) => {
  const state = types.normalizeCaseStateInput({
    id: `jf-${item.key}`, chiefComplaint: item.chiefComplaint, patient: { sex: item.sex, age: item.age },
    symptoms: { 现病史: item.presentHistory }, ...(item.tongue ? { tongue: item.tongue } : {}), ...(item.pulse ? { pulse: item.pulse } : {}), conversation: [],
  });
  const safeState = safety.sanitizeCaseStateForModel(safety.withSafetyGate(state));
  const record = pick.jingfangRecordText(safeState);
  const candidates = pick.parseJingfangCandidates(JSON.stringify(evidenceOf(item.stage1)), record);
  const grades = item.grades.flatMap((group) => group.grades);
  assert.equal(pick.jingfangEvidencePairs(candidates).length, grades.length, `${item.key} 证据对数与记录的核对结果一致`);
  const picks = pick.finalizeJingfangPicks(pick.jingfangMarkApproximate(candidates, grades), pick.jingfangVerifiedFromGrades(candidates, grades));
  return { candidates, picks };
};

await check("5.1 回放（X 集考试病例，真实模型的记录输出）：桂枝汤证×2、桂枝去芍药汤证、吴茱萸汤证×2 按现行规则选出标准方证（第八轮规则下这 5 例只选出 1 例）", () => {
  for (const key of ["X-C-0251", "X-C-0433", "X-C-0476", "X-C-0418", "X-C-0408"]) {
    const item = RECORDED.find((entry) => entry.key === key);
    const { picks } = replay(item);
    assert.equal(picks[0]?.patternName, item.expect, `${key} 首选应是 ${item.expect}，得到 ${picks.map((p) => p.patternName).join("、") || "空"}`);
  }
  // 桂枝汤证 X-C-0251：「伴恶风,汗出」一段原话对恶风与汗出各算一条
  const guizhi = replay(RECORDED.find((entry) => entry.key === "X-C-0251")).candidates[0];
  assert.ok(guizhi.evidence.filter((item) => item.quote === "伴恶风,汗出").length === 2);
});

await check("5.2 回放对照：舌象 close（X-C-0412 理中丸证）、脉象 close（X-C-0477 炙甘草汤证）、几个方证都能覆盖（S054 真武汤证）、一条逐字加一条近似（留出 S076 肾气丸证、S086 甘姜苓术汤证、S158 小承气汤证）都不选出；第八轮规则下 X-C-0412 已是误选", () => {
  for (const key of ["X-C-0412", "X-C-0477", "S054", "S076", "S086", "S158"]) {
    const { picks } = replay(RECORDED.find((entry) => entry.key === key));
    assert.deepEqual(picks.map((p) => p.patternName), [], `${key} 不应选出方证`);
  }
});

// ───────────────────────────── 6 M03 段落 ─────────────────────────────

await check("6.1 M03 采用规则：逐项对教材行（不再是教材行贴合就弃用方证）；①教材没有贴合行或教材行一项条文特征症都没有→方证 ②教材行已写全条文特征症→教材行 ③只解释一部分时看教材行的区分表现是否齐全；采用时写出符合某某汤证", () => {
  const text = jp.buildJingfangCandidateContext([{ patternName: "吴茱萸汤证", evidence: [{ quote: "时有颠顶痛", symptom: "头痛" }, { quote: "四肢欠温", symptom: "手足逆冷" }] }]);
  assert.ok(text.includes("条文特征症"));
  assert.ok(text.includes("泛化症状"));
  assert.match(text, /再逐项对教材行，不要因为教材行“大致贴合”就放弃方证/u);
  assert.match(text, /① 教材里没有贴合本例的行，或这一行的主症里一项条文特征症都没有（只有方证能解释它们）→ 采用方证/u);
  assert.match(text, /② 教材行的主症已经写全这些条文特征症（教材行同样能解释）→ 采用教材行，不采用本段（普通病例按教材写）/u);
  assert.match(text, /③ 教材行只解释了其中一部分[\s\S]*病历里齐全 → 采用教材行；缺其中一项以上 → 采用方证/u);
  assert.match(text, /写出“符合某某汤证”/u);
  assert.ok(!text.includes("仍按教材行写病名、证名、治法与代表方，不采用本段"), "第八轮的「教材行贴合就不采用」已被取代");
  // 没有选出方证时仍是空串（提示词不变）
  assert.equal(jp.buildJingfangCandidateContext([]), "");
  assert.equal(jp.buildJingfangCandidateContext(undefined), "");
  // 重要原则第 7 条（固定前缀）里有一句指向该段：列有方证候选时，教材行与方证谁优先先按该段比较（真实 M03 实测：没有这一句时 8 例选对的方证只采用 1 例，有之后 2 例，
  // 模型把固定前缀里「有贴合行就逐字采用教材」当作压倒一切的规则）
  const state = types.normalizeCaseStateInput({ id: "jf-rule7", chiefComplaint: "怕风、出汗2天", patient: { sex: "男", age: 35 }, symptoms: { 现病史: "出汗多，一吹风就觉得冷。" }, conversation: [] });
  const prompt = prompts.buildDiagnosePrompt(state, {});
  assert.ok(prompt.includes("后文列有【经方方证候选】时，教材行与方证谁优先要先按该段的采用规则逐项比较"), "第 7 条指向方证候选段");
  assert.ok(prompt.includes("「贴合」指该行主症里能把它与同病其他证型分开的表现"), "第 7 条对「贴合」的定义仍在");
});

console.log(JSON.stringify({ suite: "r1021-jingfang", cases, failures: process.exitCode ? "see above" : 0 }));
