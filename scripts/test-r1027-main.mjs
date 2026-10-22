// 10/22 第十五轮（外部复核报告：「心血不足/虚则补之/酸枣仁的证据链不完整」「西医支持事实 0 项」「酸枣仁捣碎没进煎服法」）。
// 用户定：证素核对 + 证据标签按来源 + 西医推理说明加强（三数组仍按甲方红框为空）+ 小项；页面不动。
//
//   1 证素核对：病机链、病性轴里主证/兼证名之外的虚性证素（气虚、血虚、阴虚、阳虚）按《中医诊断学》辨证要点核对，
//     不够数的从病机链、分治法、总治法、病性轴、辨证依据与总体病机里撤下，写进不确定项（m03-element-support.server.ts）。
//     证名涵盖口径宁宽勿窄：心虚胆怯涵盖心胆气虚，肝阳上亢涵盖肝肾阴虚，脾气虚涵盖脾胃气虚，阳虚涵盖同脏气虚。
//   2 教材与《中医诊断学》出处由服务端逐字核验后放行（governed-evidence-sources.server.ts）：此前证据清洗不认教材表，
//     编译器写的教材加减出处 567 条里 499 条被降成「证据不足」并清空。
//   3 证据标签按来源：病机链首节点对上教材证型行标标准资料，分治法随节点，成方组成里的药味标标准资料（delivered-surface）。
//   4 交付面把把握度说明里的校验用语换成临床写法，服务端两条「质量边界」不确定项不交付。
//   5 要捣碎的药在煎服用法里点名（「酸枣仁用前捣碎」）。
//   6 西医：病名核对改了名、或主诊断重选后，推理说明不再把原病名当结论（已存输出 74 例改名里 28 例「病名贫血 / 推理说明符合缺铁性贫血」）。

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
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const element = await jiti.import("../src/lib/m03-element-support.server.ts");
const governed = await jiti.import("../src/lib/governed-evidence-sources.server.ts");
const validation = await jiti.import("../src/lib/evidence-source-validation.ts");
const vocab = await jiti.import("../src/lib/cdss-vocab.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const nameCheck = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
const reselect = await jiti.import("../src/lib/western-primary-reselect.server.ts");

// 外部复核心悸例（本机 hospital-b 重跑的中医半形状，节选）。
const palpitation = () => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "心悸",
    primarySyndrome: "心虚胆怯证",
    primarySyndromeResolution: "bounded",
    secondarySyndromes: [],
    primarySyndromeBasis: ["心悸不宁1个月", "伴坐卧不安", "夜间入睡困难，睡后多梦易醒，醒后不易再睡", "脉象：脉弦细"],
    tcmDiagnosticRationale: "心悸不宁、情绪紧张即发、坐卧不安，为心胆气怯、神不自主，故病位在心胆；入睡困难、多梦易醒、醒后难再睡，为胆虚神扰、魂不守舍；脉弦细、舌淡红苔薄白，示血虚而气机不畅，故属心虚胆怯证。",
    overallPathogenesis: "情志触动，心胆气怯，心神不宁；肝血不足，魂不守舍",
  },
  pathogenesis: {
    natureDifferentiation: { items: ["气滞", "血虚"], rootDeficiency: ["血虚"], branchExcess: ["气滞"], basis: "脉象：脉弦细" },
    chain: [
      { patientFact: "心悸不宁1个月", syndromeEvidence: "伴坐卧不安", pathogenesis: "情志触动，心胆气机不宁，心神失宁", therapyDirection: "镇惊定志，宁心安神" },
      { patientFact: "夜间入睡困难，睡后多梦易醒，醒后不易再睡", syndromeEvidence: "脉象：脉弦细", pathogenesis: "肝血不足，魂不守舍，虚烦不寐", therapyDirection: "养血柔肝，安神助寐" },
    ],
    uncertainties: [],
  },
  therapy: { overallMethod: "镇惊定志，养心安神，养血柔肝" },
});
const fail = (unit) => ({ unit, verdict: { verdict: "fail", entry: unit.entryName, specific: 0, category: 0, listed: 0, distinct: 0 } });
const pass = (unit) => ({ unit, verdict: { verdict: "pass", entry: unit.entryName, specific: 2, category: 1, listed: 0, distinct: 3, quotes: ["面色萎黄", "唇甲色淡"] } });

await check("1.1 证素说法：最长匹配、带前面紧挨的脏腑", () => {
  const mentions = (text) => element.deficiencyMentions(text).map((m) => `${m.types.join("+")}/${m.organs.join("")}`);
  assert.deepEqual(mentions("肝血不足，魂不守舍"), ["血虚/肝"]);
  assert.deepEqual(mentions("心胆气虚，决断失司"), ["气虚/心胆"]);
  assert.deepEqual(mentions("气血两虚"), ["气虚+血虚/"]);
  assert.deepEqual(mentions("阴血不足，虚热内扰"), ["血虚/"], "阴血不足按血虚，不另算阴虚");
  assert.deepEqual(mentions("中气不足，清阳不升"), ["气虚/脾"]);
});

await check("1.2 心虚胆怯证：名外的肝血不足要核，按肝血虚证条目", () => {
  const units = element.elementCheckUnits(palpitation());
  assert.deepEqual(units.map((u) => `${u.type}→${u.entryName}`), ["血虚→肝血虚证"]);
});

await check("1.3 证名涵盖：不触发核对的几种写法", () => {
  const unitsFor = (primary, node, nature = []) => element.elementCheckUnits({
    overview: { primarySyndrome: primary, secondarySyndromes: [] },
    pathogenesis: { natureDifferentiation: { items: nature }, chain: [{ pathogenesis: node, therapyDirection: "x" }] },
  }).map((u) => u.type);
  assert.deepEqual(unitsFor("心虚胆怯证", "心胆气虚，决断失司"), [], "国标心胆气虚证即心虚胆怯证");
  assert.deepEqual(unitsFor("心脾两虚证", "心血不足，心神失养"), []);
  assert.deepEqual(unitsFor("肝阳上亢证", "肝肾阴虚，水不涵木"), [], "肝阳上亢由肝肾阴亏");
  assert.deepEqual(unitsFor("脾气虚证", "脾胃气虚，运化失职"), [], "脾、胃同组");
  assert.deepEqual(unitsFor("心阳不振证", "心气不足，鼓动无力"), [], "阳虚涵盖同脏气虚");
  assert.deepEqual(unitsFor("气血亏虚证", "脾气虚弱，运化失健"), []);
  assert.deepEqual(unitsFor("肾气不固证", "肾阳不足，固摄无权"), [], "不固同「虚」，肾涵盖各类");
  // 反向：真正的名外证素照样要核。
  assert.deepEqual(unitsFor("湿热壅盛证", "肾阳不足，气化失司"), ["阳虚"]);
  assert.deepEqual(unitsFor("肝气郁结证", "郁久伤阴，阴虚内热", ["气滞", "阴虚"]), ["阴虚"]);
});

await check("1.4 不够数：节点只删那一分句与治法项，病性轴、依据、总治法同步，写进不确定项", () => {
  const root = palpitation();
  const decision = { verdicts: element.elementCheckUnits(root).map(fail) };
  const out = JSON.parse(element.applyElementSupportDecision(JSON.stringify(root), decision, "镇惊定志，养心安神"));
  const [first, second] = out.pathogenesis.chain;
  assert.equal(out.pathogenesis.chain.length, 2, "删完还剩独立病机的节点留着");
  assert.equal(first.pathogenesis, "情志触动，心胆气机不宁，心神失宁");
  assert.equal(second.pathogenesis, "魂不守舍，虚烦不寐");
  assert.equal(second.therapyDirection, "安神助寐");
  // 动词与类别字之间夹脏腑字的写法同样算（2026-10-22 实测「养肝血，安神助寐」）。
  const organWorded = palpitation();
  organWorded.pathogenesis.chain[1].therapyDirection = "养肝血，安神助寐";
  const organOut = JSON.parse(element.applyElementSupportDecision(JSON.stringify(organWorded), decision, "镇惊定志，养心安神"));
  assert.equal(organOut.pathogenesis.chain[1].therapyDirection, "安神助寐");
  assert.equal(out.therapy.overallMethod, "镇惊定志，养心安神", "只为血虚写的「养血柔肝」去掉，教材治法项不动");
  assert.deepEqual(out.pathogenesis.natureDifferentiation.items, ["气滞"]);
  assert.deepEqual(out.pathogenesis.natureDifferentiation.rootDeficiency, []);
  assert.doesNotMatch(out.overview.tcmDiagnosticRationale, /血虚/);
  assert.match(out.overview.tcmDiagnosticRationale, /故属心虚胆怯证/);
  assert.doesNotMatch(out.overview.overallPathogenesis, /肝血不足/);
  // 按所核的条目写（肝血虚证），辨证要点取《中医诊断学》原文。
  assert.deepEqual(out.pathogenesis.uncertainties[0], {
    item: "是否兼肝血虚",
    reason: "肝血虚的辨证要点（眩晕、视力减退、肢体麻木与血虚症状共见）在本例尚未成组出现",
    affects: "望诊、问诊核实后再定是否兼顾养血",
  });
});

await check("1.5 不够数：只剩依附分句的节点整条撤下；带汗出鉴别点的节点不撤", () => {
  const root = {
    overview: { tcmDiseaseName: "崩漏", primarySyndrome: "脾虚证", secondarySyndromes: [], tcmDiagnosticRationale: "经血暴下如注、色淡红无块，为脾虚气弱、统摄无权、冲任不固，故为脾虚证。" },
    pathogenesis: {
      natureDifferentiation: { items: ["气虚", "血虚"], rootDeficiency: ["气虚", "血虚"], branchExcess: [] },
      chain: [
        { patientFact: "经血暴下", pathogenesis: "脾虚气弱，冲任不固", therapyDirection: "益气摄血，固冲止崩" },
        { patientFact: "头晕", pathogenesis: "血虚不能上荣清窍，兼失濡润", therapyDirection: "养血和络，升清止晕" },
        { patientFact: "自汗", pathogenesis: "血虚，兼失濡养", therapyDirection: "养血固表" },
      ],
      uncertainties: [],
    },
    therapy: { overallMethod: "补气摄血，固冲止崩" },
  };
  const decision = { verdicts: element.elementCheckUnits(root).map(fail) };
  const out = JSON.parse(element.applyElementSupportDecision(JSON.stringify(root), decision, ""));
  assert.deepEqual(out.pathogenesis.chain.map((n) => n.patientFact), ["经血暴下", "自汗"], "头晕那条只剩「兼失濡润」，撤下；自汗那条带鉴别点，不撤");
  assert.equal(out.pathogenesis.chain[1].pathogenesis, "血虚，兼失濡养", "不撤也删不动时原样留着");
  assert.equal(out.pathogenesis.uncertainties[0].item, "是否兼血虚", "类别总条目按类别写");
  assert.match(out.pathogenesis.uncertainties[0].reason, /^血虚的辨证要点（面、睑、唇、舌色淡白，脉细）/u);
});

await check("1.7 不够数：名外虚性证素写成首节点（实证主证）时，链上还有别的节点就撤下它；只有一个节点时不撤", () => {
  const root = (chain) => ({
    overview: { tcmDiseaseName: "水肿", primarySyndrome: "湿热壅盛证", secondarySyndromes: [] },
    pathogenesis: { natureDifferentiation: { items: ["湿热", "阳虚"], rootDeficiency: ["阳虚"], branchExcess: ["湿热"] }, chain, uncertainties: [] },
    therapy: { overallMethod: "分利湿热，温阳化气" },
  });
  const nodes = [
    { patientFact: "全身浮肿", pathogenesis: "脾肾阳虚气化失司水湿泛溢肌肤", therapyDirection: "温肾化气行水" },
    { patientFact: "口苦尿赤", pathogenesis: "水湿久蕴化热，湿热壅盛", therapyDirection: "分利湿热" },
  ];
  const two = root(nodes);
  const out = JSON.parse(element.applyElementSupportDecision(JSON.stringify(two), { verdicts: element.elementCheckUnits(two).map(fail) }, ""));
  assert.deepEqual(out.pathogenesis.chain.map((n) => n.patientFact), ["口苦尿赤"]);
  assert.equal(out.therapy.overallMethod, "分利湿热");
  const one = root(nodes.slice(0, 1));
  const kept = JSON.parse(element.applyElementSupportDecision(JSON.stringify(one), { verdicts: element.elementCheckUnits(one).map(fail) }, ""));
  assert.equal(kept.pathogenesis.chain.length, 1, "只有一个节点时不撤");
});

await check("1.6 够数：节点证据标为《中医诊断学》该条辨证要点；兼证核对补上的兼证已涵盖时不撤", () => {
  const root = palpitation();
  const units = element.elementCheckUnits(root);
  const passed = JSON.parse(element.applyElementSupportDecision(JSON.stringify(root), { verdicts: units.map(pass) }, ""));
  assert.deepEqual(passed.pathogenesis.chain[1].evidence, { evidenceLevel: "kb_entry", source: "《中医诊断学》肝血虚证辨证要点", confidence: "中" });
  assert.equal(passed.pathogenesis.chain[1].pathogenesis, "肝血不足，魂不守舍，虚烦不寐");
  const reconciled = palpitation();
  reconciled.overview.secondarySyndromes = ["肝血虚证"];
  const kept = element.applyElementSupportDecision(JSON.stringify(reconciled), { verdicts: units.map(fail) }, "");
  assert.equal(kept, JSON.stringify(reconciled), "兼证已涵盖：原样返回");
});

await check("1.8 只核证名没涵盖的脏腑；证名没有这一类时脏腑条目不够数再按总条目核，总条目够数则保留并标「低」", () => {
  const units = element.elementCheckUnits({
    overview: { primarySyndrome: "肾气虚证", secondarySyndromes: [] },
    pathogenesis: { natureDifferentiation: { items: [] }, chain: [{ pathogenesis: "脾肾气虚，运化失司", therapyDirection: "健脾益气" }] },
  });
  assert.deepEqual(units.map((u) => `${u.type}/${u.organs.join("")}→${u.entryName}`), ["气虚/脾→脾气虚证"], "肾已由主证涵盖，只核脾");
  const v = (verdict, entry) => ({ verdict, entry, specific: 0, category: 0, listed: 0, distinct: 0 });
  assert.deepEqual(element.combinedElementVerdict(v("pass", "肾阳虚证"), v("pass", "阳虚证")), { verdict: v("pass", "肾阳虚证"), confidence: "中" });
  assert.deepEqual(element.combinedElementVerdict(v("fail", "肾阳虚证"), v("pass", "阳虚证")), { verdict: v("pass", "阳虚证"), confidence: "低" });
  assert.deepEqual(element.combinedElementVerdict(v("fail", "肾阳虚证"), v("fail", "阳虚证")), { verdict: v("fail", "肾阳虚证") });
  assert.deepEqual(element.combinedElementVerdict(v("fail", "脾气虚证"), undefined), { verdict: v("fail", "脾气虚证") });
  const root = {
    overview: { primarySyndrome: "湿热壅盛证", secondarySyndromes: [] },
    pathogenesis: { natureDifferentiation: { items: [] }, chain: [{ pathogenesis: "湿热壅盛", therapyDirection: "分利湿热" }, { pathogenesis: "肾阳不足，气化失司", therapyDirection: "温肾化气" }], uncertainties: [] },
    therapy: { overallMethod: "分利湿热" },
  };
  const [unit] = element.elementCheckUnits(root);
  const out = JSON.parse(element.applyElementSupportDecision(JSON.stringify(root), { verdicts: [{ unit, verdict: v("pass", "阳虚证"), confidence: "低" }] }, ""));
  assert.deepEqual(out.pathogenesis.chain[1].evidence, { evidenceLevel: "kb_entry", source: "《中医诊断学》阳虚证辨证要点", confidence: "低" });
});

await check("2.1 受治理出处核验：教材证型行、教材加减原文、《中医诊断学》辨证要点", () => {
  const ok = governed.governedEvidenceSourceVerified;
  assert.equal(ok("《中医内科学》心悸·心虚胆怯证"), true);
  assert.equal(ok("《中医内科学》心悸·心虚胆怯证加减：兼心血不足，加阿胶、制何首乌、龙眼肉"), true);
  assert.equal(ok("《中医内科学》心悸·心虚胆怯证加减：兼心血不足，加酸枣仁"), false, "加减原文须逐字在表里");
  assert.equal(ok("《中医外科学》心悸·心虚胆怯证"), false, "书名不对");
  assert.equal(ok("《中医内科学》心悸·心血不足证加减：兼心血不足，加阿胶、制何首乌、龙眼肉"), false, "加减原文须属于那一行");
  assert.equal(ok("《中医诊断学》血虚证辨证要点"), true);
  assert.equal(ok("《中医诊断学》血虚型辨证要点"), false);
});

await check("2.2 证据清洗：kb_entry 的受治理出处核验后放行；病例内推理带书名号照旧降级；没给核验函数时不放行", () => {
  const scope = { ...validation.buildEvidenceScope(""), governed: governed.governedEvidenceSourceVerified };
  const evidence = (level, source) => ({ evidence: { evidenceLevel: level, source, confidence: "中" } });
  const source = "《中医内科学》心悸·心虚胆怯证加减：兼心血不足，加阿胶、制何首乌、龙眼肉";
  assert.equal(validation.sanitizeEvidenceObject(evidence("kb_entry", source), scope, vocab.EVIDENCE_LEVELS).evidence.evidenceLevel, "kb_entry");
  assert.equal(validation.sanitizeEvidenceObject(evidence("model_inference", source), scope, vocab.EVIDENCE_LEVELS).evidence.evidenceLevel, "insufficient");
  assert.equal(validation.sanitizeEvidenceObject(evidence("kb_entry", "《中医内科学》心悸·心虚胆怯证加减：加酸枣仁"), scope, vocab.EVIDENCE_LEVELS).evidence.evidenceLevel, "insufficient");
  assert.equal(validation.sanitizeEvidenceObject(evidence("kb_entry", source), validation.buildEvidenceScope(""), vocab.EVIDENCE_LEVELS).evidence.evidenceLevel, "insufficient");
});

await check("2.3 编译器：教材加减写标准资料与教材出处；病历原文触发与条件句是病例内推理（条件句「低」）", () => {
  const source = readFileSync("src/lib/m04-proposal-compiler.ts", "utf8");
  assert.match(source, /evidenceLevel: "kb_entry" as const,\s*source: `\$\{textbookRowProvenance\(textbookSource\)\}加减：\$\{textbookSource\.raw\}`/);
  assert.match(source, /confidence: triggerSource \? "中" as const : "低" as const/);
});

await check("2.4 路由：两个阶段的证据清洗都传入受治理出处核验；中医半收口并行跑证素核对、落在兼证核对之后", () => {
  for (const route of ["src/app/api/diagnosis/diagnose/route.ts", "src/app/api/diagnosis/prescribe/route.ts"]) {
    assert.match(readFileSync(route, "utf8"), /governedEvidenceSourceVerified,\n\s*\)/, route);
  }
  const diagnose = readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  assert.match(diagnose, /decideElementSupport\(completed, \{ recordText: trustedInputText\(safeState\) \}, transformSignal\)/);
  assert.match(diagnose, /applyPatientClaimRemovalsToContent\(applyElementSupportDecision\(reconciled, elementDecision\), "tcm", claimRemovals\)/);
});

const diagnoseForSurface = () => {
  const root = palpitation();
  root.pathogenesis.chain = root.pathogenesis.chain.slice(0, 1);
  root.therapy.subTherapies = [{ therapy: "镇惊定志，宁心安神", targetPathogenesis: "情志触动，心胆气机不宁，心神失宁", priority: "主要", evidence: { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" } }];
  root.pathogenesis.chain[0].evidence = { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" };
  root.westernDiagnosis = { primary: { name: "心脏神经症", supportingFacts: [], limitations: [], suggestedChecks: [], clinicalRationale: "心悸与情绪紧张相关" }, differentials: [], candidates: [] };
  return root;
};

await check("3.1 证据标签：首节点对上教材证型行为标准资料（出处为该行），分治法随节点；幂等", () => {
  const once = surface.projectDeliveredReasoning(diagnoseForSurface());
  const expected = { evidenceLevel: "kb_entry", source: "《中医内科学》心悸·心虚胆怯证", confidence: "中" };
  assert.deepEqual(once.pathogenesis.chain[0].evidence, expected);
  assert.deepEqual(once.therapy.subTherapies[0].evidence, expected);
  assert.deepEqual(surface.projectDeliveredReasoning(once), once);
  const unmatched = diagnoseForSurface();
  unmatched.overview.primarySyndrome = "心神不宁证";
  assert.equal(surface.projectDeliveredReasoning(unmatched).pathogenesis.chain[0].evidence.evidenceLevel, "model_inference", "对不上教材行不改");
});

await check("3.2 证据标签：成方组成里的药味为标准资料（出处同方剂出处），加味的药不动", () => {
  const reasoning = { ...diagnoseForSurface(), stage: "prescribe", formula: { candidates: [{
    name: "安神定志丸加减",
    formulaNames: ["安神定志丸"],
    formulaSource: { evidenceLevel: "kb_entry", source: "安神定志丸：《医学心悟》卷四", confidence: "中" },
    herbs: ["茯苓", "茯神", "远志", "人参", "石菖蒲", "龙齿", "白芍"].map((name) => ({ name, dose: "10g", role: "佐", evidence: { evidenceLevel: "model_inference", source: "基于本例证候、病机、治法与候选药味的配伍分析", confidence: "中" } })),
  }], modifications: [], patentAndWestern: [] } };
  const herbs = surface.projectDeliveredReasoning(reasoning).formula.candidates[0].herbs;
  const level = (name) => herbs.find((herb) => herb.name === name).evidence;
  assert.deepEqual(level("龙齿"), { evidenceLevel: "kb_entry", source: "安神定志丸：《医学心悟》卷四", confidence: "中" });
  assert.equal(level("人参").evidenceLevel, "kb_entry");
  assert.equal(level("白芍").evidenceLevel, "model_inference", "原方没有的加味药不标");
});

await check("4.1 把握度说明里的校验用语换成临床写法；服务端两条质量边界不确定项不交付", () => {
  const root = diagnoseForSurface();
  root.overview.primarySyndromeResolutionReason = "证型“心虚胆怯证”仅有2条可逐字回溯的本例依据，尚未达到稳定结论所需证据";
  root.pathogenesis.locationDifferentiation = { items: ["心"], resolution: "bounded", resolutionReason: "病位“心、胆”仅有2条互相独立且可逐字回溯的本例依据" };
  root.pathogenesis.natureDifferentiation.resolutionReason = "病性“气滞”缺少可逐字回溯的本例依据，暂不能标记为已解决";
  root.pathogenesis.uncertainties = [
    { item: "辨证推理质量边界", reason: "部分支撑说明、分类或鉴别深度仍不充分；已保留可回溯的患者事实、工作证候及病机治法。", affects: "影响结论深度" },
    { item: "寒热喜恶", reason: "未记录，难以判断有无虚热", affects: "影响是否兼清虚热" },
  ];
  const out = surface.projectDeliveredReasoning(root);
  assert.equal(out.overview.primarySyndromeResolutionReason, "证型“心虚胆怯证”的病历依据有2条，尚需进一步明确");
  assert.equal(out.pathogenesis.locationDifferentiation.resolutionReason, "病位“心、胆”的病历依据有2条");
  assert.equal(out.pathogenesis.natureDifferentiation.resolutionReason, "病性“气滞”的病历依据较少，尚需进一步明确");
  assert.deepEqual(out.pathogenesis.uncertainties.map((row) => row.item), ["寒热喜恶"]);
  assert.equal(surface.clinicalWordingForSyntheticPhrases("寒热病性目前缺少两个以上相互独立的证据维度，已按有界建议展示。"), "寒热属性的依据少于两个方面，尚需进一步明确。");
});

await check("5.1 煎服用法点名要捣碎的药，写在下药时机之后", () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    overview: { primarySyndrome: "心虚胆怯证" }, therapy: { overallMethod: "镇惊定志，养心安神" },
    formula: { candidates: [{ name: "安神定志丸加减", herbs: [
      { name: "龙齿", decoctionRequirement: "先煎" }, { name: "人参", decoctionRequirement: "另煎" },
      { name: "酸枣仁", decoctionRequirement: "捣碎后同煎" }, { name: "茯苓", decoctionRequirement: "" },
    ], decoction: { dosesPerDay: 1, administrationTimesPerDay: 2 } }] },
  };
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = visible.applyDeterministicDecoctionMethod(content, "男，30岁");
  const method = JSON.parse(out.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).formula.candidates[0].decoction.method;
  assert.match(method, /^每日1剂，龙齿先煎20–30分钟，人参另煎兑入，酸枣仁用前捣碎，余药加水浸泡/);
});

await check("5.2 酸枣仁「先煎」改「捣碎后同煎」只改它自己那一处，同一行别的先煎药不动", async () => {
  const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  const fix = (line) => provenance.enrichPrescriptionProvenance(line, "");
  assert.equal(fix("每日1剂，龙齿先煎20–30分钟，人参另煎兑入，酸枣仁用前捣碎，余药加水浸泡30分钟"), "每日1剂，龙齿先煎20–30分钟，人参另煎兑入，酸枣仁用前捣碎，余药加水浸泡30分钟");
  assert.equal(fix("龙齿先煎30分钟，酸枣仁先煎20分钟"), "龙齿先煎30分钟，酸枣仁捣碎后同煎");
  assert.equal(fix("酸枣仁 15g 先煎"), "酸枣仁 15g 捣碎后同煎");
});

await check("6.1 病名降级后推理说明不再把原病名当结论（D 类写「考虑X可能」，其余写「需与X鉴别」）", () => {
  const align = nameCheck.rationaleAlignedWithRenamedPrimary;
  assert.equal(align("长期月经过多伴头晕，血红蛋白96g/L，符合缺铁性贫血；需查铁代谢与失血原因以确立。", "缺铁性贫血", "D"),
    "长期月经过多伴头晕，血红蛋白96g/L，考虑缺铁性贫血可能；需查铁代谢与失血原因以确立。");
  assert.equal(align("绝经后女性慢性腰痛伴X线骨质疏松表现，支持绝经后骨质疏松症；需骨密度确认。", "绝经后骨质疏松症", "D"),
    "绝经后女性慢性腰痛伴X线骨质疏松表现，考虑绝经后骨质疏松症可能；需骨密度确认。");
  assert.equal(align("反复发作性头痛，暂按偏头痛考虑并需排除继发因素。", "偏头痛", "D"), "反复发作性头痛，偏头痛可能并需排除继发因素。");
  assert.equal(align("血红蛋白92g/L，缺铁性贫血可能性大，需查铁代谢。", "缺铁性贫血", "D"), "血红蛋白92g/L，缺铁性贫血可能性大，需查铁代谢。", "已是推测语气的不动");
  assert.equal(align("夜间胸痛，符合冠心病心绞痛表现。", "冠心病心绞痛", "A"), "夜间胸痛，需与冠心病心绞痛鉴别。");
  const content = JSON.stringify({ westernDiagnosis: { primary: { name: "缺铁性贫血", clinicalRationale: "血红蛋白96g/L，符合缺铁性贫血；需查铁代谢。" }, candidates: [], differentials: [] } });
  const corrected = JSON.parse(nameCheck.applyWesternNameCorrection(content, { supportedName: "贫血", quote: "血红蛋白96g/L", reason: "未查铁代谢", type: "D" }));
  assert.equal(corrected.westernDiagnosis.primary.name, "贫血");
  assert.equal(corrected.westernDiagnosis.primary.clinicalRationale, "血红蛋白96g/L，考虑缺铁性贫血可能；需查铁代谢。");
});

await check("6.2 主诊断重选后推理说明跟着改：换名写上理由与新病名，补并发症写上那句理由", () => {
  const content = (rationale) => JSON.stringify({ westernDiagnosis: { primary: { name: "急性弥漫性腹膜炎", clinicalRationale: rationale }, candidates: [], differentials: [] } });
  const replaced = JSON.parse(reselect.applyWesternPrimaryReselection(content("全腹压痛反跳痛，符合急性弥漫性腹膜炎；需急诊外科评估。"),
    { action: "replace", name: "绞窄性肠梗阻", quote: "腹腔穿刺抽出血性臭味液", reason: "腹穿血性臭味液指向肠绞窄" }));
  assert.equal(replaced.westernDiagnosis.primary.clinicalRationale, "腹穿血性臭味液指向肠绞窄，考虑绞窄性肠梗阻；全腹压痛反跳痛，需与急性弥漫性腹膜炎鉴别；需急诊外科评估。");
  const appended = JSON.parse(reselect.applyWesternPrimaryReselection(content("全腹压痛反跳痛，符合急性弥漫性腹膜炎。"),
    { action: "append", name: "感染性休克", quote: "血压80/50mmHg，四肢湿冷", reason: "低血压伴四肢湿冷提示休克" }));
  assert.equal(appended.westernDiagnosis.primary.clinicalRationale, "全腹压痛反跳痛，符合急性弥漫性腹膜炎；低血压伴四肢湿冷提示休克。");
});

console.log(`\n${cases} checks`);
