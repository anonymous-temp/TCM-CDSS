// 10/25 第十九轮（网上基层病历 A056、A033 两类 + 知识库接入复查）。
//
//   1 病历读法三值（recordedFindingReading）与否认净化：否认列举后的裸词与另一处明确否认并存时按逐项否认读（A056 不再「有呕吐；否认呕吐」）；
//     逐字照录病历原文不改写；前后两种记载并存时只写阳性、不再另出一句否认；只有「否认列举后裸词」一种记载时看事实抽取模型的阳性表，
//     没有就写明记载不明确；带了自己谓语的小句、隔得远的裸词不算否认。
//   2 闸门：开头一句无关的否认不再吞掉后面带肯定证据的阳性表现（无咳嗽，胸痛，伴大汗 / 无头痛，言语不清，右侧肢体无力 / 无恶心，黑便3次）；
//     逐项否认的裸词列举照旧不报。
//   3 中医病名须解释本次就诊原因（m03-visit-reason-check）：主诉主段、只在病名不是选病第一个时才核、核对结论的逐字与闭集守卫、
//     候选段写明这条原则、辨证路由接上重抽。
//   4 知识库接入：开方阶段本例命中的规则排在两份通用索引之前（证据块裁剪先裁通用索引）；辨证阶段 EviMed 与开方阶段同一条选取规则
//     （首个过了病例相关性过滤的查询胜出）；辨证签名后的开方预取与开方路由用同一份工作辨证（补回支持事实），规划器检索带口语否定增补。

import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

process.env.CDSS_EVIDENCE_FETCH_CACHE = "false";
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

const D = await jiti.import("../src/lib/diagnosis-safety.ts");
const T = await jiti.import("../src/lib/diagnosis-types.ts");
const state = (presentHistory, extra = {}) => {
  const normalized = T.normalizeCaseStateInput({
    chiefComplaint: extra.chiefComplaint || "不适3天",
    symptoms: { presentHistory },
    conversation: [],
    patient: { sex: "男", age: extra.age ?? 50 },
  });
  // 事实层是服务端写的字段，请求体里的会在规范化时丢掉；这里直接挂到规范化后的状态上。
  return extra.clinicalFacts ? { ...normalized, clinicalFacts: extra.clinicalFacts } : normalized;
};
const A056 = "患儿于三天前开始腹泻，一天7-8次，蛋花样，无腹痛，发热，呕吐，于乡卫生院输液治疗两天无效，并有加重趋势。到我卫生室就诊，患儿今天已腹泻十余次，全身状况良，神疲，精神萎靡，无呕吐，发热。";

await check("1.1 A056：发热、呕吐、腹痛都读成否认；模型照病历写「无呕吐」「无发热」不改写", () => {
  for (const term of ["发热", "呕吐", "腹痛"]) assert.equal(D.recordedFindingReading(A056, term), "denied", term);
  const st = state(A056, { chiefComplaint: "蛋花样便三天", age: 0.67 });
  const out = D.sanitizeUngroundedRedFlagNegations("辨证依据：腹泻蛋花样，无呕吐；本例无发热。", st);
  assert.equal(out, "辨证依据：腹泻蛋花样，无呕吐；本例无发热。");
  assert.doesNotMatch(out, /阳性/);
});

await check("1.2 逐字照录病历原文的一段不改写（A056 交付成「有呕吐；有呕吐；否认呕吐，发热」）", () => {
  const st = state(A056, { chiefComplaint: "蛋花样便三天", age: 0.67 });
  const quote = "现病史摘录：全身状况良，神疲，精神萎靡，无呕吐，发热。";
  assert.equal(D.sanitizeUngroundedRedFlagNegations(quote, st), quote);
  // 病程里先有后无（「伴呕吐2次。今日无呕吐」）：照录后一句不改成「呕吐阳性」。
  const hx = "腹泻3天，起病时伴呕吐2次。今日无呕吐，精神可，进食少。";
  assert.equal(D.recordedFindingReading(hx, "呕吐"), "conflicting");
  const verbatim = "病历记载：今日无呕吐，精神可，进食少。";
  assert.equal(D.sanitizeUngroundedRedFlagNegations(verbatim, state(hx, { chiefComplaint: "腹泻3天" })), verbatim);
  // 不是照录的否认仍被改正——第二十轮起改正方式是删掉这一条（不再改写成「病历已记录呕吐阳性」）。
  assert.equal(D.sanitizeUngroundedRedFlagNegations("本例无呕吐。", state(hx, { chiefComplaint: "腹泻3天" })), "", "不是照录的否认仍被改正");
});

await check("1.3 病历前后两种记载并存：模型的否认删掉（第二十轮起不改写成阳性），同一句不另出一句否认", () => {
  const hx = "否认胸痛。今日上午突发胸痛2小时，伴大汗。";
  assert.equal(D.recordedFindingReading(hx, "胸痛"), "conflicting");
  const out = D.sanitizeUngroundedRedFlagNegations("鉴别：本例无胸痛，不支持。", state(hx, { chiefComplaint: "胸痛2小时" }));
  assert.equal(out, "");
  assert.doesNotMatch(out, /否认胸痛|无胸痛|阳性/);
});

await check("1.4 病历明确肯定、前面隔着固定的「无」字说法（疲乏无力、面色无华）：模型的「无X」被改正（此前按首次出现判成照录否认）", () => {
  const hx = "眩晕、头痛、疲乏无力、左侧偏瘫、胸痛、汗出、口干欲饮。";
  assert.equal(D.recordedFindingReading(hx, "胸痛"), "affirmed");
  assert.equal(D.sanitizeUngroundedRedFlagNegations("鉴别要点：本例无胸痛，与之不符。", state(hx, { chiefComplaint: "眩晕十年" })), "");
});

await check("1.5 只有「否认列举后的裸词」一种记载：事实模型列为阳性的删掉这条否认，否则写明记载不明确", () => {
  const hx = "无腹痛，发热，呕吐，于乡卫生院输液治疗两天无效，并有加重趋势。";
  assert.equal(D.recordedFindingReading(hx, "发热"), "ambiguous");
  const plain = D.sanitizeUngroundedRedFlagNegations("鉴别要点：本例无发热，与之不符。", state(hx));
  assert.match(plain, /发热的有无病历记载不明确，需核实/);
  assert.doesNotMatch(plain, /阳性|本例无发热/);
  const withFacts = D.sanitizeUngroundedRedFlagNegations("鉴别要点：本例无发热，与之不符。", state(hx, {
    clinicalFacts: { affirmedSymptoms: [{ term: "发热", quote: "发热" }] },
  }));
  assert.equal(withFacts, "");
});

await check("1.6 带了自己谓语的小句（咳嗽有痰）、隔得远的裸词（…小便调，便秘）不算病历的否认", () => {
  const cough = "昨日起憎寒壮热，头项强痛，肢体疼痛，无汗，鼻塞声重，咳嗽有痰，胸膈痞闷。";
  assert.notEqual(D.recordedFindingReading(cough, "咳嗽"), "denied");
  assert.doesNotMatch(D.sanitizeUngroundedRedFlagNegations("鉴别要点：本例无咳嗽，与之不符。", state(cough)), /本例无咳嗽/);
  const far = "自汗，纳差，无食欲，眠差，入睡困难，小便调，便秘，一日一行。";
  assert.notEqual(D.recordedFindingReading(far, "便秘"), "denied");
});

const gate = (hx, cc = "不适1天") => D.withSafetyGate(state(hx, { chiefComplaint: cc, age: 60 })).safetyGate;
await check("2.1 闸门：开头一句无关的否认不再吞掉后面带肯定证据的阳性表现（与去掉否认的兄弟句同判）", () => {
  for (const [subject, sibling] of [
    ["无咳嗽，胸痛，伴大汗", "胸痛，伴大汗"],
    ["无头痛，言语不清，右侧肢体无力", "言语不清，右侧肢体无力"],
    ["无恶心，黑便3次", "黑便3次"],
    ["无咳嗽，乏力，胸痛，大汗淋漓", "乏力，胸痛，大汗淋漓"],
  ]) {
    assert.equal(gate(sibling).status, "red_flag", `兄弟句 ${sibling}`);
    assert.equal(gate(subject).status, "red_flag", subject);
  }
});

await check("2.2 闸门：逐项否认的裸词列举、顿号列举、否认项自己起首的照旧不报", () => {
  for (const hx of ["头晕3天，否认胸痛，胸闷，气促。", "头晕3天，无胸痛，大汗，呕血。", "头晕3天，无胸痛、大汗、呕血。", "头晕3天，无发热，无胸痛，无呕血2次。"]) {
    assert.equal(gate(hx, "头晕3天").redFlags.length, 0, hx);
  }
});

const V = await jiti.import("../src/lib/m03-visit-reason-check.server.ts");
await check("3.1 主诉主段：第一个「伴/兼/合并」或括号之前", () => {
  assert.equal(V.chiefComplaintLeadSegment("感冒后发热2周（伴自幼遗尿）"), "感冒后发热2周");
  assert.equal(V.chiefComplaintLeadSegment("发热2天，伴腹胀、纳差"), "发热2天,", "比较用 NFKC 紧凑形");
  assert.equal(V.chiefComplaintLeadSegment("经期延长伴经量明显增多2个月"), "经期延长");
  assert.equal(V.chiefComplaintLeadSegment("头晕半年"), "头晕半年");
});

await check("3.2 只在病名不是选病第一个、且病名不在主诉主段里时才核", () => {
  const base = { chiefComplaint: "感冒后发热2周（伴自幼遗尿）", presentHistory: "", picks: ["发热", "遗尿"] };
  assert.equal(V.visitReasonCheckApplies({ ...base, disease: "遗尿" }), true);
  assert.equal(V.visitReasonCheckApplies({ ...base, disease: "发热" }), false, "就是选病第一个");
  assert.equal(V.visitReasonCheckApplies({ chiefComplaint: "经期延长伴经量明显增多2个月", presentHistory: "", picks: ["月经过多", "经期延长"], disease: "经期延长" }), false, "病名写在主诉主段里（C067）");
  assert.equal(V.visitReasonCheckApplies({ ...base, disease: "遗尿", picks: [] }), false, "选病落空不核");
});

await check("3.3 核对结论的守卫：就诊原因须逐字出自主诉主段，更合适的病名须是选病之一且不是原病名；拿不准当已解释", () => {
  const input = { chiefComplaint: "感冒后发热2周（伴自幼遗尿）", presentHistory: "", picks: ["发热", "遗尿"], disease: "遗尿" };
  const ok = V.parseVisitReasonVerdict(JSON.stringify({ verdict: "not_covered", visitReason: "感冒后发热2周", better: "发热", reason: "遗尿是自幼宿疾" }), input);
  assert.equal(ok.status, "not_covered");
  assert.equal(ok.better, "发热");
  assert.equal(V.parseVisitReasonVerdict(JSON.stringify({ verdict: "not_covered", visitReason: "自幼遗尿", better: "发热" }), input).status, "unknown", "引的是括号里的伴随问题");
  assert.equal(V.parseVisitReasonVerdict(JSON.stringify({ verdict: "not_covered", visitReason: "发热3周", better: "发热" }), input).status, "unknown", "不是主诉原文");
  assert.equal(V.parseVisitReasonVerdict(JSON.stringify({ verdict: "not_covered", visitReason: "感冒后发热2周", better: "感冒" }), input).status, "unknown", "更合适的病名不在选病里");
  assert.equal(V.parseVisitReasonVerdict(JSON.stringify({ verdict: "not_covered", visitReason: "感冒后发热2周", better: null }), input).status, "unknown", "没有可换的病不重写");
  assert.equal(V.parseVisitReasonVerdict(JSON.stringify({ verdict: "covered" }), input).status, "covered");
  assert.equal(V.parseVisitReasonVerdict("not json", input).status, "unknown");
  const instruction = V.visitReasonRedrawInstruction("遗尿", ok);
  assert.match(instruction, /本次就诊原因是主诉里的「感冒后发热2周」/);
  assert.match(instruction, /「遗尿」/);
  assert.match(instruction, /如「发热」/);
});

await check("3.4 教材候选段：病名必须能解释本次就诊原因写在「整组表现比较」之前", async () => {
  const S = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
  const context = S.buildTextbookCandidateContext({ chiefComplaint: "感冒后发热2周（伴自幼遗尿）", presentHistory: "患儿2周前感冒后出现发热，口臭，口干，大便干，小便黄。每晚遗尿", sex: "男", ageYears: 6, preferredDiseases: ["发热", "遗尿"] });
  const visit = context.indexOf("病名必须能解释本次就诊原因");
  const whole = context.indexOf("逐病找出其下与本例最贴合的一行证型");
  assert.ok(visit > 0 && whole > visit, "原则在前、整组比较在后");
  assert.match(context, /只对应伴随症状（「伴」之后、括号里补充的）、自幼或多年的宿疾/);
  assert.ok(S.textbookDiseaseDefinition("遗尿", 6).includes("遗尿"), "核对器拿得到教材定义");
});

await check("3.5 辨证路由接上核对与重抽：核对与其余收口并行，不解释时按就诊原因重抽中医半、再走一遍收口", () => {
  const route = fs.readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  assert.match(route, /checkDiseaseExplainsVisitReason\(\{ \.\.\.visitReasonInput, disease, picks: textbookDiseasePicks \}/);
  assert.match(route, /Promise\.all\(\[\s*checkDiseaseExplainsVisitReason[\s\S]*?finishTcmHalf\(tcmContent\)/);
  assert.match(route, /await redraw\(visitReasonRedrawInstruction\(disease, visit\)\)/);
  assert.match(route, /adopted && redrawn \? finishTcmHalf\(redrawn\) : finished/);
  const api = fs.readFileSync("src/lib/diagnosis-api.ts", "utf8");
  assert.match(api, /opts\.m03TcmHalfTransform\(accumulatedContent, upstreamController\.signal, redrawTcmHalf\)/);
  assert.match(api, /prompt: `\$\{m03ParallelHalves\.tcm\}\\n\\n\$\{instruction\}`/);
  assert.match(api, /checkNonStrictStructuredContent\(tcmHalfTask, attempt\.content\)/, "重抽稿过同一套结构核对");
});

await check("4.1 开方阶段：本例命中的规则排在两份通用索引之前；证据块按预算裁剪后仍在", async () => {
  const K = await jiti.import("../src/lib/tcm-knowledge.ts");
  const B = await jiti.import("../src/lib/prompt-budget.ts");
  const st = state("胸闷心悸，房颤病史，长期服华法林3mg qd、阿托伐他汀；平素服复方丹参滴丸", { chiefComplaint: "胸闷心悸1月", age: 68 });
  const kb = K.buildTcmKnowledgeContext(st, "prescribe");
  const hits = kb.indexOf("命中中成药重点风险"), pairs = kb.indexOf("模型生成前置配伍核验索引"), doses = kb.indexOf("候选处方剂量限定名单");
  assert.ok(hits > 0 && pairs > hits && doses > pairs, "命中规则 → 配伍索引 → 剂量名单");
  const evidence = ["【外部证据与院内知识支持】", "## 官方基础依据", "依据".repeat(200), kb, "## EviMed 指南/共识检索", "条目\n".repeat(3000)].join("\n\n");
  const bounded = B.compactEvidenceContextForPrompt(evidence, 15_000);
  assert.equal(bounded.truncated, true);
  for (const key of ["命中饮片/药味规则", "复方丹参制剂", "他汀活动性肝病"]) assert.ok(bounded.text.includes(key), key);
  const diagnose = K.buildTcmKnowledgeContext(st, "diagnose");
  assert.ok(diagnose.indexOf("全局规则") < diagnose.indexOf("命中饮片/药味规则"), "辨证阶段顺序不变");
});

await check("4.2 辨证阶段 EviMed：首个问题查询的条目全被病例相关性过滤掉时，用下一个过得了的查询（与开方阶段同一规则）", async () => {
  process.env.EVIMED_GUIDE_API_KEY = "test-only-placeholder";
  delete process.env.EVIMED_LITERATURE_API_KEY;
  delete process.env.EVIMED_INSTRUCTION_API_KEY;
  delete process.env.CDSS_EVIDENCE_RELEVANCE_FILTER;
  const E = await jiti.import("../src/lib/evimed-guide.ts");
  const st = { patient: { sex: "女", age: 50 }, chiefComplaint: "胃脘疼痛一月余", symptoms: { presentHistory: "胃脘胀满，隐痛，食后加重，大便溏薄。" }, conversation: [] };
  const [first] = E.buildEvidenceFallbackQueries(st, "diagnose", "guide");
  assert.ok(first, "辨证阶段有问题查询");
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const query = JSON.parse(options.body).query;
    calls.push(query);
    const titles = query === first ? ["黄褐斑诊疗专家共识（2021）"] : ["成人急性感染性腹泻诊疗专家共识（2022）"];
    return new Response(JSON.stringify({ code: 200, data: { list: titles.map((title) => ({ title, year: "2024", publisher: "中华医学会" })) } }), { headers: { "content-type": "application/json" } });
  };
  try {
    const context = await E.buildExternalEvidenceContext(st, "diagnose");
    assert.ok(calls.includes(first));
    assert.match(context, /成人急性感染性腹泻诊疗专家共识/);
    assert.doesNotMatch(context, /黄褐斑/);
  } finally {
    globalThis.fetch = previous;
  }
});

await check("4.3 开方预取与开方路由用同一份工作辨证（补回支持事实）；规划器检索带口语否定增补", async () => {
  const W = await jiti.import("../src/lib/prescribe-working-reasoning.ts");
  const prior = {
    stage: "diagnose",
    westernDiagnosis: { primary: { name: "慢性胃炎", supportingFacts: [] }, differentials: [] },
    overview: { primarySyndromeResolution: "bounded", tcmDiseaseName: "胃痛", primarySyndrome: "肝气犯胃证" },
    pathogenesis: { chain: [{ node: "x" }] },
  };
  const st = { symptoms: { presentHistory: "胃脘胀痛半月，嗳气频作，无呕血黑便。" } };
  const working = W.prescribeWorkingPriorReasoning(st, prior);
  assert.ok(working.westernDiagnosis.primary.supportingFacts.length > 0, "补回了支持事实");
  assert.equal(prior.westernDiagnosis.primary.supportingFacts.length, 0, "不改原对象");
  const limited = { ...prior, overview: { ...prior.overview, primarySyndromeResolution: "unresolved" }, pathogenesis: { chain: [] } };
  assert.equal(W.prescribeWorkingPriorReasoning(st, limited), limited, "有限结论不补");
  const prefetch = fs.readFileSync("src/lib/stage-prefetch.server.ts", "utf8");
  assert.match(prefetch, /reasoningDiagnose: prescribeWorkingPriorReasoning\(gatedCaseState,/);
  assert.match(prefetch, /assistedPolarityDecisions\(safeState\)[\s\S]{0,120}planEvidenceBoundMedicineCandidates\(safeState, customerId, undefined, assistedNegations\)/);
  const route = fs.readFileSync("src/app/api/diagnosis/prescribe/route.ts", "utf8");
  assert.match(route, /signedPriorReasoning = prescribeWorkingPriorReasoning\(parsed\.caseState, signedPriorReasoning\)/);
  assert.match(route, /planEvidenceBoundMedicineCandidates\(safeState, parsed\.customer\.customerId, signal, assistedNegations\)/);
  const planner = fs.readFileSync("src/lib/medicine-candidate-planner.server.ts", "utf8");
  assert.match(planner, /let otcPool = retrieveLocalPatentMedicineCandidates\(caseState, patentSynced \? 60 : 10, assistedNegations\)/);
});

console.log(`${cases} checks`);
