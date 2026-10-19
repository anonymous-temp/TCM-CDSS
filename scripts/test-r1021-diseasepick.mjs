// 第九轮 WP9-F（2026-10-19 晚）：中医病名选择。留出集仅剩的两个病名+证候双错：
//   · S078（头晕、肢麻、胁痛、抽筋、筋惕、面色不华、月经量多后量少；金标 虚劳·肝血虚证）被定成眩晕·气血亏虚证、归脾汤；
//   · S151（儿童，咳嗽咳黄痰、发热，明确无气促、无鼻翼扇动，胸片无实变；金标 咳嗽·痰热咳嗽）被定成肺炎喘嗽·痰热闭肺证。
//
// 根因（离线探针 112 例 + 真实链路量过）：
//   闭集选择两例都已把金标病名选在前两位（眩晕、虚劳；肺炎喘嗽、咳嗽），失误在后面——辨证提示词默认第一个病是本例的病，
//   S078 的主诉「头晕」是眩晕也是虚劳血虚证的一项，整组表现却与虚劳·肝血虚证的教材主症逐项对上；
//   S151 的教材肺炎喘嗽诊断依据是「气急、鼻扇、痰鸣」，病历已明确否认，而候选里只有证型行、没有病的定义与诊断依据，模型看不到。
//   选择提示词本身的几种改法（清单附教材定义；整组表现归病；加既往史与辅助检查）都没有提高第一位命中，
//   且各有退步（胃痞被带去吐酸；甲方病历 3 排到产后身痛之后），所以提示词不动（见 textbook-disease-pick.server.ts 注释）。
//
// 本轮的改动在候选一侧：
//   1 被点名的病里，另一个病「与本例最贴合的一行」相近分比排第一的病高出 PICKED_DISEASE_ROW_FIT_MARGIN 以上时提到第一位；
//   2 候选里每个病附教材定义与教材诊断依据原文，并写明先定病名的看法（教材必备表现已否认的不算符合、西医病名只作旁证）；
//   3 证名只差末尾「证/型」时用教材行的写法（候选变长后「血虚头痛」被写成「血虚头痛证」，同一病历两次生成字面不同）。
//
// 每条断言带对照，反证记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt（前缀 9/diseasepick）。

import assert from "node:assert/strict";
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

const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const pick = await jiti.import("../src/lib/textbook-disease-pick.server.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");

// 留出集病历（合成，按教材证型行写成）
const S078 = {
  chiefComplaint: "头晕、肢体麻木半年",
  presentHistory: "患者近2年月经量多，半年来头晕，眼前发花，两侧胁肋隐隐作痛，手脚发麻，夜间小腿常抽筋，眼皮和面部肌肉时有跳动，月经推后、量转少，面色没有光泽。无肢体无力，无言语不清，无头痛。",
  tongue: "舌质淡，苔薄", pulse: "脉弦细", sex: "女", ageYears: 45,
};
const S032 = {
  chiefComplaint: "头晕3月",
  presentHistory: "患者3个月来头晕，活动或劳累后加重，休息后减轻，面色发白，精神疲倦，稍动就出汗，不愿多说话，口唇、指甲颜色淡，头发枯干，时有心慌，睡眠浅，吃得少，饭后腹胀。无视物旋转，无耳鸣，无肢体无力。",
  tongue: "舌淡，苔薄白", pulse: "脉细弱", sex: "女", ageYears: 31,
};
const S151 = {
  chiefComplaint: "咳嗽、咳黄痰1周",
  presentHistory: "患儿7岁，1周前感冒后咳嗽逐渐加重，痰多，颜色黄、质黏稠，咳吐不爽，喉咙里有痰鸣声，发热，体温37.8～38.0℃，口渴，烦躁，小便少而黄，大便干结。无气促，无鼻翼扇动，无口唇发紫，无胸痛。精神尚可，食欲减退。",
  tongue: "舌质红，苔黄腻", pulse: "脉滑数", sex: "女", ageYears: 7,
};
const orderOf = (record, preferred, options = { maxDiseases: 4, maxRowsPerDisease: 12 }) =>
  textbook.textbookCandidatesForCase({ ...record, preferredDiseases: preferred }, options).map((item) => item.disease);

await check("1.1 S078：闭集选择给 [眩晕, 虚劳]，虚劳·肝血虚证一行与整组表现逐项对上，虚劳提到第一位；S032（同是头晕贫血，教材眩晕·气血亏虚证逐项对上）仍是眩晕第一（对照）", () => {
  assert.deepEqual(orderOf(S078, ["眩晕", "虚劳"]), ["虚劳", "眩晕"]);
  assert.deepEqual(orderOf(S032, ["眩晕", "虚劳"]), ["眩晕", "虚劳"]);
});

await check("1.2 提前的条件是差距：只有一个病、选择顺序里本来就排第一、差距不到阈值时不动；阈值是导出的数值常量", () => {
  assert.equal(textbook.PICKED_DISEASE_ROW_FIT_MARGIN, 4);
  assert.deepEqual(orderOf(S078, ["虚劳", "眩晕"]), ["虚劳", "眩晕"], "选择已把虚劳排第一");
  assert.deepEqual(orderOf(S078, ["眩晕"]), ["眩晕"], "只有一个病");
  // S151：咳嗽一行比肺炎喘嗽一行高约 2 分，不到阈值，顺序不动（这一例由候选里的教材诊断依据在辨证时纠正，见 2.1）
  assert.deepEqual(orderOf(S151, ["肺炎喘嗽", "咳嗽"]), ["肺炎喘嗽", "咳嗽"]);
  // 病历 3（头痛，产后血虚）：头痛的血虚头痛行 5.5 分对虚劳 3 分，差距不到 4，头痛仍第一
  const case3 = {
    chiefComplaint: "头痛2+月",
    presentHistory: "两个多月前患者生产后出现头痛，呈隐痛，时发时止，遇疲劳、受风后加重，伴头晕、心悸、神疲乏力。发病后因自觉症状不重，未正规诊治。现头痛较前加重，遂来就诊。发病以来患者神疲、面色少华，食欲下降，睡眠差，小便清长，大便稀溏。",
    tongue: "舌淡白，苔薄，苔白", pulse: "脉细弱", sex: "女", ageYears: 32,
  };
  assert.deepEqual(orderOf(case3, ["头痛", "虚劳"]).slice(0, 1), ["头痛"]);
});

await check("1.3 已给病名（开方阶段 diseaseName）时不重排；没有选择结果时候选完全由字面检索定，不受提前影响（对照）", () => {
  const named = textbook.textbookCandidatesForCase({ ...S078, diseaseName: "眩晕", preferredDiseases: ["眩晕", "虚劳"] }, { maxDiseases: 4 }).map((item) => item.disease);
  assert.equal(named[0], "眩晕");
  assert.ok(!named.includes("虚劳"), "已定病名时只取这个病");
  const literal = textbook.textbookCandidatesForCase(S078, { maxDiseases: 3 }).map((item) => item.disease);
  assert.ok(literal.length > 0);
});

await check("2.1 S151 候选里每个病带教材定义与教材诊断依据：肺炎喘嗽的诊断依据写「气急、鼻扇、痰鸣」，咳嗽的写「肺纹理增粗」；提示词写明必备表现已否认的不算符合、西医病名只作旁证", () => {
  const context = textbook.buildTextbookCandidateContext({ ...S151, preferredDiseases: ["肺炎喘嗽", "咳嗽"] });
  assert.match(context, /◆ 肺炎喘嗽[\s\S]*教材定义：肺炎喘嗽是小儿时期常见的肺系疾病/);
  assert.match(context, /教材诊断依据：[^\n]*气急、鼻扇、痰鸣/);
  assert.match(context, /◆ 咳嗽[\s\S]*教材诊断依据：[^\n]*肺纹理增粗/);
  assert.match(context, /必备表现而病历已明确否认的，不算符合/);
  assert.match(context, /西医诊断与检查结果只作旁证，不直接决定中医病名/);
  assert.match(context, /各病的先后只是检索时的初排，不表示哪个更可能/);
  // 定义与诊断依据排在病名行之后、证型行之前
  const lines = context.split("\n");
  const head = lines.findIndex((line) => line.startsWith("◆ 肺炎喘嗽"));
  const firstRow = lines.findIndex((line, index) => index > head && line.startsWith("  - "));
  const definition = lines.findIndex((line, index) => index > head && line.startsWith("  教材定义："));
  assert.ok(head < definition && definition < firstRow, JSON.stringify({ head, definition, firstRow }));
});

await check("2.2 对照：教材没有诊断依据的病（吐酸只有一句定义）只写定义、不写空的「教材诊断依据：」；序号被去掉、不出现「。；」", () => {
  const context = textbook.buildTextbookCandidateContext({ chiefComplaint: "反酸、烧心1月", presentHistory: "反酸，烧心，餐后加重", sex: "男", ageYears: 40, preferredDiseases: ["吐酸"] });
  const block = context.split("\n").filter((line) => /^◆|^  教材/.test(line)).join("\n");
  assert.match(block, /◆ 吐酸/);
  assert.match(block, /教材定义：吐酸是指胃中酸水上泛/);
  assert.doesNotMatch(block, /教材诊断依据：\s*$/m);
  const withPoints = textbook.buildTextbookCandidateContext({ ...S151, preferredDiseases: ["咳嗽"] });
  assert.doesNotMatch(withPoints, /教材诊断依据：[^\n]*(?:。；|；；|\b1\.|1\.病史)/);
});

await check("3.1 选择请求：提示词与闭集清单不变（只有主诉与现病史，清单是教材病名本身，不带定义）；调用参数 temperature 0、max_tokens 120", () => {
  const request = pick.buildTextbookDiseasePickRequest({
    chiefComplaint: S078.chiefComplaint, patient: { sex: "女", age: 45 }, symptoms: { presentHistory: S078.presentHistory }, pastHistory: "否认高血压",
  });
  assert.ok(request);
  assert.ok(request.allowed.has("虚劳") && request.allowed.has("眩晕") && !request.allowed.has("男性不育症肾阳虚"));
  const [system, user] = request.messages;
  assert.match(system.content, /2\. 以主诉（本次就诊的主要不适）为准选病名；伴随症状不单独立病/);
  assert.match(system.content, /5\. 「反复感冒、容易感冒」/);
  const body = JSON.parse(user.content);
  assert.ok(Array.isArray(body.textbookDiseaseNames) && body.textbookDiseaseNames.includes("虚劳"));
  assert.ok(!body.textbookDiseaseNames.some((name) => name.includes("｜")), "清单项不带定义");
  assert.doesNotMatch(user.content, /既往史|否认高血压/, "选择不读既往史（量过：加既往史与辅助检查没有收益）");
  const params = pick.textbookDiseasePickCallParams("deepseek-flash");
  assert.equal(params.temperature, 0);
  assert.equal(params.max_tokens, 120);
  assert.equal(params.stream, false);
  assert.equal(pick.buildTextbookDiseasePickRequest({ chiefComplaint: "  ", patient: {}, symptoms: {} }), undefined);
});

await check("3.2 闭集解析：清单外的名字丢弃、去重、最多 3 个（原行为不变）", () => {
  const allowed = new Set(["眩晕", "虚劳", "咳嗽", "胃痞"]);
  assert.deepEqual(pick.parseTextbookDiseasePick(JSON.stringify({ diseases: ["眩晕", "眩晕", "不存在的病", "虚劳", "咳嗽", "胃痞"] }), allowed), ["眩晕", "虚劳", "咳嗽"]);
  assert.deepEqual(pick.parseTextbookDiseasePick("不是 JSON", allowed), []);
});

const reasoning = (disease, syndrome, rationale) => ({
  stage: "diagnose",
  overview: {
    tcmDiseaseName: disease, primarySyndrome: syndrome, secondarySyndromes: [], recommendedFormulaDirection: "加味四物汤加减",
    tcmDiagnosticRationale: rationale, tcmDiseaseRationale: `以头痛为主症，故归${disease}。`,
  },
  therapy: { overallMethod: "养血和络止痛" }, pathogenesis: { chain: [] },
});

await check("4.1 证名只差末尾「证」：教材「血虚头痛」，模型写「血虚头痛证」→ 证名与辨证依据里的写法都按教材；教材「燥热便秘」同理", () => {
  const out = provenance.withDeterministicFormulaReferences(reasoning("头痛", "血虚头痛证", "头痛隐痛，面色少华，舌淡脉细弱，诸症合为血虚头痛证。"));
  assert.equal(out.overview.primarySyndrome, "血虚头痛");
  assert.match(out.overview.tcmDiagnosticRationale, /诸症合为血虚头痛。$/);
  const plain = provenance.withDeterministicFormulaReferences(reasoning("头痛", "血虚头痛", "诸症合为血虚头痛。"));
  assert.equal(plain.overview.primarySyndrome, "血虚头痛");
  assert.equal(plain.overview.tcmDiagnosticRationale, "诸症合为血虚头痛。", "已是教材写法，不动");
});

await check("4.2 教材行带「证」而模型漏写时补上，且正文里已经带「证」的地方不重复（「风寒束表证」不变成「风寒束表证证」）；不同证名不被拉到别的行（对照）", () => {
  const out = provenance.withDeterministicFormulaReferences({
    stage: "diagnose",
    overview: {
      tcmDiseaseName: "感冒", primarySyndrome: "风寒束表", secondarySyndromes: [], recommendedFormulaDirection: "荆防败毒散加减",
      tcmDiagnosticRationale: "恶寒重发热轻无汗，风寒束表证；风寒束表为主。", tcmDiseaseRationale: "鼻塞流涕，故归感冒。",
    },
    therapy: { overallMethod: "辛温解表" }, pathogenesis: { chain: [] },
  });
  assert.equal(out.overview.primarySyndrome, "风寒束表证");
  assert.equal(out.overview.tcmDiagnosticRationale, "恶寒重发热轻无汗，风寒束表证；风寒束表证为主。");
  const other = provenance.withDeterministicFormulaReferences({
    stage: "diagnose",
    overview: { tcmDiseaseName: "感冒", primarySyndrome: "风热犯表证", secondarySyndromes: [], recommendedFormulaDirection: "银翘散加减", tcmDiagnosticRationale: "发热微恶风。", tcmDiseaseRationale: "故归感冒。" },
    therapy: { overallMethod: "辛凉解表" }, pathogenesis: { chain: [] },
  });
  assert.equal(other.overview.primarySyndrome, "风热犯表证");
});

console.log(JSON.stringify({ suite: "r1021-diseasepick", cases, failures: process.exitCode ? "see above" : 0 }));
